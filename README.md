# Auto Refine for SillyTavern

A SillyTavern port of [Lumiverse Auto Refine](https://github.com/starlitcode/Lumiverse-Auto-Refine) by starlitcode.

It sends a finished reply to a model with the rules you wrote, and saves the rewrite over the original. The text it replaced is kept, so you can put it back.

- **It leaves the greeting alone**, unless **Refine the greeting** is on.
- **Nothing is written that you cannot undo.** **Put it back** restores the wording a refine replaced.
- **It checks the rewrite before saving it.** A rewrite is dropped when the model declines, talks about the edit, sends nothing, changes nothing, grows or shrinks past your limits, tones down strong words, comes back garbled, or loses formatting such as tags, code or image links.

## Install

1. In SillyTavern, open **Extensions** (the stacked blocks icon).
2. Press **Install extension**.
3. Paste the address of this repository and press **Install**.
4. Open **Auto Refine** in the Extensions panel.

It needs SillyTavern 1.13 or later. To refine with a different model than the one you chat with, the built-in **Connection Manager** extension has to be on, with a profile saved for that model.

## Ways to refine

| Where | What it does |
| --- | --- |
| **Refine each new reply automatically** (panel) | Refines every new reply. Off by default. |
| The wand button on a message (in its **...** menu) | Refines that message. |
| The undo button on a message | Puts back the text from before the refine. Only shown on a message that can be put back. |
| Wand menu, **Refine latest reply** | Refines the latest reply. |
| Wand menu, **Refine my latest message** | Refines your latest message, with the prompt for your own messages. |
| Wand menu, **Refine selected text** | Select text in a message first. Only that part is rewritten. |
| Wand menu, **Cut selected text** | Takes the selected text out of the message, with no model call. It can be put back. |
| Wand menu, **Refine what I am typing** | Rewrites the draft in the message box. Click the notice to put the old draft back. |
| Panel, **Refine every reply** / **Refine all my messages** | Goes through the whole chat. **Stop** ends it. |
| Panel, **Show me the request** | Shows the request a refine would send. No model is called. |

Slash commands:

- `/refine` refines the latest reply. `/refine 12` refines message 12.
- `/refine-mine` refines your latest message.
- `/refine-all` refines every reply. `/refine-all mine=true` refines every message of yours.
- `/refine-undo` puts back the latest refine. `/refine-undo 12` puts back message 12.
- `/refine-stop` stops the refine that is running.
- `/refine-draft` refines the text in the message box.

## The prompt

The request is a list of blocks you can edit, reorder, switch off or add to. It is in the **Prompt** section of the panel. Replies and your own messages each have their own prompt.

Four built-in prompts come with it, the same as in Lumiverse Auto Refine:

- **A judge**, for replies. It improves how a reply reads and leaves what happens alone.
- **A line judge**, for your own messages. It fixes mistakes and leaves your style alone.
- Each has a version **that thinks**, for a model that reasons.

The upstream docs explain them: [How the prompt is built](https://github.com/starlitcode/Lumiverse-Auto-Refine/blob/stable/docs/prompt.md) and [What it refuses to save](https://github.com/starlitcode/Lumiverse-Auto-Refine/blob/stable/docs/guardrails.md).

Macros:

- `{{message}}` is the message being refined. Every prompt needs it.
- `{{history}}`, `{{lore}}`, `{{overused}}`, `{{whole_reply}}` and `{{protect_notes}}` are filled in by Auto Refine.
- SillyTavern's own macros, such as `{{description}}`, `{{persona}}`, `{{char}}` and `{{user}}`, are filled in by SillyTavern.

## What is the same as in Lumiverse

The refining is done by the original engine, copied without changes into `engine/backend.js`. That covers:

- how the request is built from the prompt blocks, history, lore and card;
- every check on the rewrite before it is saved;
- hiding markup, code and thinking from the model and putting it back after;
- asking again after a failed check, several rewrites at once, and waiting out a busy provider;
- worn-out phrases, refining a selection, cutting a selection, and put-back.

## What is different

- **The panel is new.** It sits in SillyTavern's Extensions panel, not in a drawer tab. It has the same settings, grouped in sections.
- **Refine using** lists your Connection Manager profiles. Empty uses the API SillyTavern is connected to.
- **Samplers** are sent only with a Connection Manager profile. With the connected API, its own settings are used.
- **Lore** is the lorebook entries the last generation in the chat activated. Before the first generation after a page load, there is none.
- **Stop** with the connected API stops waiting and throws the answer away. The call itself finishes in the background, because stopping it would also stop a chat reply.
- **Thinking effort** is not sent. Use a Connection Manager profile with the reasoning settings you want.
- **Not included:** two models (it needs Lumiverse's Decision connections), several passes, the floating button, sounds, themes and pattern backgrounds, `{{memories}}` (always empty), and streaming progress.
- **Settings** are kept in SillyTavern's settings, under `auto_refine`. Put-back is kept after a reload only when **Keep it after a reload** is on.
- **Message ids.** Each message Auto Refine reads is given an id in its `extra` data, `auto_refine_id`, so a put-back finds the right message after another message is deleted.

## Updating the engine

`engine/` is copied from a checkout of Lumiverse Auto Refine by a script. Nothing in it is edited by hand.

```bash
bash tools/vendor.sh /path/to/Lumiverse-Auto-Refine
```

The script copies `dist/backend.js` into `engine/backend.js` inside one wrapper function, and copies the built-in prompts, checks and notes from `dist/frontend.js` into `engine/prompts.js`.

## Files

| File | What it is |
| --- | --- |
| `manifest.json` | What SillyTavern reads to load the extension |
| `index.js` | The panel, message buttons, wand menu items and slash commands |
| `host.js` | Runs the engine on SillyTavern's API: chat, model calls, storage and events |
| `engine/backend.js` | The refine engine from Lumiverse Auto Refine |
| `engine/prompts.js` | The built-in prompts, checks and notes from Lumiverse Auto Refine |
| `style.css` | Styles, using SillyTavern's theme colors |
| `tools/vendor.sh` | Copies `engine/` from a Lumiverse Auto Refine checkout |

## Made for adults

Auto Refine is for adults, 18 and older. It is not for sexual content involving minors. See [The one thing they do not edit](https://github.com/starlitcode/Lumiverse-Auto-Refine/blob/stable/docs/prompt.md#the-one-thing-they-do-not-edit) in the original docs.

## Credits and license

- **starlitcode** built and maintains [Lumiverse Auto Refine](https://github.com/starlitcode/Lumiverse-Auto-Refine). The engine and the built-in prompts are theirs.
- This port adds the SillyTavern panel and the adapter.

Licensed under the GNU General Public License v3.0, the same as the original. See [LICENSE](LICENSE).
