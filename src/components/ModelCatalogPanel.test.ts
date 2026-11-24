import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ModelInstallConsent } from './ModelCatalogPanel';
import { componentEntrySchema } from '../../electron/componentCatalog';
describe('per-install model consent', () => {
  it('shows model, creator, source, linked licence, size and full hashes without initiating an install', () => {
    const entry = componentEntrySchema.parse({ id:'test-model',version:'1',name:'Test Model',author:'Test Creator',source:'https://github.com/test/model',license:'CC BY-NC-SA 4.0',licenseUrl:'https://creativecommons.org/licenses/by-nc-sa/4.0/',kind:'model',platforms:['win32'],vendors:['nvidia'],channel:'experimental',notes:'Testing',files:[{path:'model.onnx',url:'https://raw.githubusercontent.com/test/model/pin/model.onnx',sha256:'a'.repeat(64),bytes:12345}],model:{file:'model.onnx',adapter:'rgb-image-v1',type:'image',scale:2,frames:1,spatialMultiple:2}});
    const accept = vi.fn();
    const html = renderToStaticMarkup(createElement(ModelInstallConsent, { entry, busy: false, message: '', onClose: () => {}, onAccept: accept }));
    for (const text of [entry.name,entry.author,entry.source,entry.license,entry.licenseUrl,entry.files[0].sha256,'12,345','Accept and install','Cancel']) expect(html).toContain(text);
    expect(accept).not.toHaveBeenCalled();
  });
});
