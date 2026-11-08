/** Repair guidance derived from real Python/VapourSynth failures, never arbitrary pip commands. */
export function filterFailureHint(output: string): string | null {
  const missing = /No module named ['"]([\w.]+)['"]/i.exec(output);
  if (missing) return `This filter needs the Python module "${missing[1]}". Open Plugins and run Install plugins or Partial reinstall, then validate again. If the module belongs to an external filter, install the author's compatible dependency in Vapourkit's private Python environment; installing it into system Python will not fix this filter.`;
  const plugin = /No (?:attribute|function) with (?:the )?name ['"]?([\w]+)['"]? (?:exists|found)/i.exec(output);
  if (plugin) return `VapourSynth cannot find "${plugin[1]}". Open Plugins and try Partial reinstall. For an external native plugin, install the correct Windows/Linux and VapourSynth API build into Settings → VS Plugins, restart Vapourkit, then validate again. A Windows DLL cannot run on Linux.`;
  if (/DLL load failed|cannot open shared object|failed to load.*(?:plugin|library)|undefined symbol/i.test(output)) return 'A filter dependency could not load. Run Plugins → Partial reinstall. External plugins must match your operating system, architecture and VapourSynth API; check the filter author’s runtime requirements, restart, then validate again.';
  if (/SyntaxError|IndentationError|unexpected keyword argument|has no attribute|NameError/i.test(output)) return 'The imported filter code is incompatible or incomplete. Edit the filter and check its variables, indentation and the installed plugin version against the author’s instructions. Validate the workflow again after correcting it; reinstalling unrelated packages will not repair Python code.';
  return null;
}
