/**
 * Ask domain — composes prompts with context-injection for delegation
 * to `bin/claude.exe` (ADR-0003).
 *
 * @module @domains/ask
 */

export { composePrompt } from './prompt-composer.js';
export { AskError, type ComposedPrompt, type ComposeOpts } from './types.js';
