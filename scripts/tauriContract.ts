/** Keep the Electron inventory and the preview's Rust/TypeScript command names in sync. */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const parse = (file: string) => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
const visit = (node: ts.Node, fn: (node: ts.Node) => void) => { fn(node); node.forEachChild(child => visit(child, fn)); };
const source = parse('electron/preload.ts');
let api: ts.ObjectLiteralExpression | undefined;
visit(source, node => {
  if (ts.isCallExpression(node) && node.expression.getText(source) === 'contextBridge.exposeInMainWorld'
      && node.arguments[0]?.getText(source) === "'electronAPI'" && ts.isObjectLiteralExpression(node.arguments[1])) api = node.arguments[1];
});
if (!api) throw new Error('Electron preload API was not found');
const equivalents: Record<string, string[]> = {
  selectVideoFile: ['select_native_file'], selectReferenceVideo: ['select_native_file'], selectOutputFile: ['select_native_output'],
  getVideoInfo: ['inspect_media'], getVideoThumbnail: ['read_native_frame'], getVideoFrameAt: ['read_native_frame'],
  getQueue: ['native_queue_snapshot'], saveQueue: ['edit_native_queue'], clearQueue: ['edit_native_queue'],
  startUpscale: ['encode_sample'], cancelUpscale: ['cancel_sample'], killUpscale: ['cancel_sample'],
  getNvencDriverProblem: ['check_native_encoder'], onUpscaleProgress: ['native-encode-progress'],
};
const methods = api.properties.map(property => {
  if (!ts.isPropertyAssignment(property)) throw new Error('Unexpected preload property');
  const method = property.name.getText(source);
  const calls: { transport: string; channel: string }[] = [];
  visit(property.initializer, node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
    if (node.expression.expression.getText(source) !== 'ipcRenderer') return;
    const argument = node.arguments[0];
    if (!argument || !ts.isStringLiteral(argument)) return;
    if (['invoke', 'on', 'sendSync'].includes(node.expression.name.text)) {
      calls.push({ transport: node.expression.name.text, channel: argument.text });
    }
  });
  return {
    method,
    parameters: ts.isArrowFunction(property.initializer) ? property.initializer.parameters.map(p => p.getText(source)) : [],
    transports: calls,
    productionAdapter: 'pending',
    previewBuildingBlocks: equivalents[method] ?? [],
  };
});
const host = read('src-tauri/src/host.rs');
const commands = [...host.matchAll(/#\[tauri::command\]\s*(?:async\s+)?fn\s+(\w+)/g)].map(match => match[1]).sort();
const registration = host.match(/tauri::generate_handler!\[([\s\S]*?)\]/)?.[1] ?? '';
const registered = registration.split(',').map(value => value.trim()).filter(Boolean).sort();
if (JSON.stringify(commands) !== JSON.stringify(registered)) throw new Error('Rust commands and generate_handler! registration differ');
const adapter = parse('src/native/host.ts');
visit(adapter, node => {
  if (!ts.isCallExpression(node) || node.expression.getText(adapter) !== 'invoke') return;
  const argument = node.arguments[0];
  if (!argument || !ts.isStringLiteral(argument) || !commands.includes(argument.text)) {
    throw new Error(`Unregistered native invocation: ${node.getText(adapter)}`);
  }
});
const inventory = {
  schemaVersion: 1,
  productionRendererReady: false,
  note: 'Preview building blocks have distinct contracts. They do not implement the production electronAPI; no endpoint is marked complete until the original UI and persisted schema are migrated and tested.',
  previewTransport: 'Electron preview-port transfers MessagePorts; Tauri currently provides individual JPEG frames over binary IPC, not streaming chain preview.',
  nativeCommands: commands,
  electronMethods: methods,
};
const output = JSON.stringify(inventory, null, 2) + '\n';
const filename = 'docs/TAURI_CONTRACT.json';
if (process.argv.includes('--check')) {
  if (read(filename) !== output) throw new Error(`Migration contract is stale. Run npm run update:tauri-contract and review ${filename}.`);
} else fs.writeFileSync(path.join(root, filename), output);
console.log(`Checked ${methods.length} Electron methods and ${commands.length} native commands. Production renderer migration is pending.`);
