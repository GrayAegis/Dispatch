# Dispatch

A SillyTavern extension. When in-fiction time passes, the world produces things your character could come across: a paper on a stall, a text, a voicemail, a note under the door, a file left open. They wait in an in-tray. The narrator is told only that they are *there*; you read them if you want, and the narrator learns what they say only when you choose to bring one into the scene.

The same writer makes **artefacts** to order: the police file on your character, the Planet's piece about last night, an NPC's diary page, a letter never sent. Rendered as the document they are, kept in a library, and filed to the chat's lorebook if you want them to be canon.

No extra calls during normal play. One call when time passes (if enabled), one per artefact you ask for.

## How it works

**Time passing.** After each reply, Dispatch reads the reply's state comment (`<!-- state … time: … -->`, as the Nemo-style State Comment prompt writes it) and compares the clock with the last one; it also reads what you wrote since the last reply ("I sleep", "two days later", "(skip to morning)"). If more than the threshold passed (default 3 hours), the world moves. There is also a *Time passed* tab and `/dispatch hours=12` for when neither catches it.

**What the world writes.** A second request with its own instructions, the card's description, your persona, the lorebook entries currently firing, and the last N messages. It answers with one or more documents (kind, source, title, date, where it could be found, body). Kinds: news article, TV/radio transcript, text thread, voicemail, note, letter, official file, diary page, poster.

**What the narrator is told.** For one turn: a short note that these things exist and where (“a stall on the corner”, “her phone lighting up once”), with instructions to make them present in a sentence of ordinary detail and not to read them out. Nothing about their contents.

**Reading.** The in-tray button by the input (with an unread count) opens the tray. Each document renders as itself: a newspaper page, a phone thread, a file with a stamp.

**Bringing one in.** On a document, *Bring into the scene* tells the narrator, for one turn, that your character has just read it, verbatim, and that the people around react only to what they can see — not to the contents unless they already know them. Your next message is still yours; nothing decides what your character makes of it.

**Filing.** *File to lorebook* writes the document into the chat-bound lorebook as a keyed entry (title, source, author as keys), so it enters the prompt only when it's relevant later.

**Artefacts.** *New document* in the tray, or `/artefact kind=file author="GCPD" subject="the girl on the roof"`. Same writer, same rendering, goes to the Library; nothing enters the story unless you bring it in or file it.

## Install

Extensions → Install Extension → paste this repository's URL.

## Settings

Extensions panel → Dispatch: enable; let the world move on its own; hours that count as time passing; documents per dispatch; how many recent messages the writer sees; a connection profile for the writer (a cheaper model works well; default is your main API); max tokens.

## Notes

- Without a state comment in replies, only what you write ("hours later") or the Time passed tab triggers a dispatch.
- The writer is asked for JSON; if a model answers with prose instead, nothing is added and the console says so. Models that follow instructions well (your main model, or a mid-size instruct model) are fine.
- Filing needs a character chat; group chats and the no-character assistant chat have no chat-bound lorebook.
