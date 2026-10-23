import { readHost } from '../integrations/foundry/host.js';
import { registerFoundation } from '../integrations/foundry/register-foundation.js';
import { readEditorHost, registerEditor } from '../integrations/foundry/register-editor.js';

declare const __MODULE_VERSION__: string;

registerFoundation(readHost(), __MODULE_VERSION__, true);
registerEditor(readEditorHost());
