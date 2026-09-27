# Using the App

After connecting, the left sidebar organizes servers and channels, the center
shows chat or the voice stage, and the right side lists members. Connecting
to a server and joining a call are separate actions.

<AppScreenshot src="/screenshots/conversa-en.png" alt="A demo conversation with servers and channels on the left, messages in the center and members on the right." caption="Windows client capture using demo data. The names, conversation and bot were created for this guide." />

## Voice

Click a **voice channel** to join the call. Whoever speaks gets a green ring around the avatar. The bottom bar has microphone, headphones/deafen and disconnect. The panel shows average ping and lets you leave only the call.

Right-click a participant to adjust their individual volume. The setting applies only on this computer and to that device: if the same person is connected from two machines, each one gets its own volume.

The call follows you: switching servers in the left column keeps it running, and the icon of the server hosting it stays marked. Joining a voice channel on another server moves the call there. See [Several servers at once](/en/entrar-em-um-servidor#several-servers-at-once).

## Camera and screen

On the media bar: **Camera**, **Share Screen** and **Soundboard**. Choose a screen
or a specific window; screen-audio availability depends on the platform and
source. Check what will be captured before starting.

Under **Settings → Voice and Video → Camera**, preview blur, color or image
virtual backgrounds and physical-screen chroma key. Effects run locally and
also apply to the call. Closing the preview does not stop a camera in use;
see limitations and precautions in [settings](/en/configuracoes).

In the quick preview, selecting **Image** without a background keeps the panel
open and displays an inline warning. Preview stays off and its switch is disabled
until you choose an image. This also applies to chroma key with an image
replacement; unprocessed video is never published as a fallback.

People allowed to watch see a **LIVE** badge. Click the card to spotlight it or use fullscreen.

### Adjusting FPS for the encoder

In **Quality** settings, every resolution, FPS, bitrate, preset, codec, or
encoding-method change validates the combination before reapplying a stream.
**Manual** mode keeps your selected codec and encoding method.
If the profile is unsupported, the app tests lower frame rates and
adjusts FPS only after confirming a compatible combination on this computer —
for example, from 4K120 to 4K60. A notice explains the adjustment; resolution,
bitrate, camera, and audio remain unchanged.

Existing camera and audio numeric limits still apply; checking screen encoding
does not require starting the webcam. The app does not invent encoder bitrate
limits. Temporary verification failures do not lower FPS. If no option is
compatible, the profile change is not applied: adjust quality or choose another
encoder. During a stream, adjustments follow the
same validation as manual quality changes; if the change is blocked, the
previous profile is kept.

### Private screen sharing

In the screen or window picker, enable **Private screen share** and open
**Who can watch**. The dropdown supports searching and selecting multiple
**Users** or **Roles**, with user avatars, role colors, and a scrollable list.
Selections are summarized in the field; reopen the list to deselect someone.
Selecting a user **or** one of their
roles grants access; both are not required. Select at least one: an empty
selection blocks starting and never makes the stream public. New streams are
public by default.

Everyone else sees no stream, LIVE badge, or screen audio indicator.
Administrators do not get automatic access either. The server checks the
audience before allowing video or audio; knowing a stream identifier does not
grant access. Channel permissions and membership in the same voice call still
apply.

The selection stays with the stream across source replacements, reconnects,
and quality changes, and identifies the person rather than a single device.
Removing or deleting a role immediately revokes subscriptions that depend on
it, without stopping microphones or other authorized streams. Granting a role
makes the stream visible. Choose the audience before starting; to define a
different one, stop the stream and start again.

### Who is watching

On clients and servers supporting viewer lists (protocol 30), each screen-share
card shows up to two avatars and **+N watching** for the rest, without repeating
the total count. Hover, click, or use the
keyboard to open the complete list; **Escape** closes it. Everyone in the call
who can see the stream can inspect its viewers, even without watching.
Private streams remain restricted to their authorized audience.

When you are watching, the expanded list says **You and X other people are watching**.
The list counts connections with accepted subscriptions, not merely people
allowed to watch, and does not prove attention to the screen. Two connections
from the same person appear separately. It refreshes approximately every two
seconds; failed requests show an unavailable state rather than a stale count.
The local preview is not counted as a viewer.

## Chat

Each text channel has history saved on the server, avatars, timestamps, basic formatting and an anti-flood limit of 10 messages every 5 seconds.

On compatible servers, your messages show **Sending**, **Sent to server**, or
**Failed to send** beside their timestamp. Confirmation means the server received
the message, not that someone read it. **Try again** retries the same message
without duplicates, including when its earlier acknowledgement was lost.
Text, replies, code and attachments remain in the session's outbox when switching
channels or reconnecting to the same server and identity. The outbox is kept in
memory while the application is open, not in a permanent local message archive.

The default limit is **16,000 characters**, configurable under **Server settings
→ General**. Turning the switch off removes the character limit, not the 8 MiB
packet protection. The counter follows changes without reconnecting. On compatible
servers, controls for features that were not negotiated explain that an update
is needed.

A message you started but haven't sent stays with the channel you were typing in. Jumping to the voice stage, opening another channel and coming back does not wipe the text — each channel keeps its own draft, which only goes away when you send the message or leave the server.

Hover over a message (or reach its buttons with `Tab`) to reveal a floating toolbar with **Emoji**, **Reply**, **Copy message** and **More options**. The three-dot menu displays full action names; **Edit message** is only available to the author when the server permits editing, and **Delete message** to the author or moderators. Navigate menus with arrow keys and close them with `Escape`.

After deleting a message, **Undo** restores the same message, including its blocks, attachments and reactions, for **60 seconds** by default. Switching channels or reconnecting does not cancel the server-controlled time window. Only the person who deleted it can undo; restoring someone else's message still requires moderation permission. Authors cannot reverse a moderator's deletion. Reply references show the restored message again without creating another message or repeating mention notifications.

Use **Server settings → Notifications → Deletion undo window (seconds)**, or the CLI key `messageDeleteUndoSeconds`, to set **1 to 86,400 seconds**. Changes apply only to future deletions. Restoration is no longer possible once the deadline expires. Content is kept in a private temporary server backup during the window and removed in the next periodic cleanup after expiry. This feature requires both client and server to support protocol **27**; earlier clients cannot apply restorations.

`Ctrl+C` copies selected text with its displayed formatting; `Ctrl+Shift+C` copies the same text without formatting. On macOS, use `Cmd` instead of `Ctrl`. Without a selection, the shortcut acts only on the focused message, never the entire conversation. **Copy message**, both in the toolbar and under **More options**, defaults to formatted copying, just like `Ctrl+C`. Those buttons also respect a selection within the message. In the menu, clicking the label, `Enter` or `Space` performs that copy; hovering, clicking the arrow or pressing `→` opens **Copy with formatting**, **Copy Markdown** and **Copy without formatting**. Use `←` or `Escape` to go back and `Tab` to leave.

Formatted copying provides HTML for rich-text applications and visible text for plain-text destinations, without adding markers such as `**`. **Copy Markdown** explicitly copies the original markup. **Copy without formatting** provides only visible text, without Markdown or HTML. Pasting a formatted copy into Monky restores its editable markup; external HTML is never inserted into the interface. Image-only and sticker-only messages copy the image; other attachments, or **Copy without formatting**, copy file names without transferring attachments.

The message field previews Markdown as you type and when editing an existing message. Headings, bold, italic, strike, quotes, and code are displayed with formatting; markers appear dimmed around the cursor and disappear elsewhere. Code blocks use the same editor for composition and editing, with a language selector, line numbers and syntax highlighting, without showing the surrounding backticks. The original text is preserved for sending and editing. Reply previews also render formatting, including code and list markers. Numbered lists retain the first number you entered, such as `4. item`.

Addresses starting with `http://`, `https://` or `www.` are recognized as links while typing and become clickable in the sent message. This does not insert markup into the draft, change links created through the form, or apply inside code. Addresses starting with `www.` open over HTTPS; surrounding punctuation is not included in the link.

Right-click the message field for **Cut**, **Copy**, **Paste**, **Paste as plain text** and **Select all**, with their corresponding shortcuts. Unavailable actions are disabled. Right-click a link in the editor for **Copy link** (its address), **Open link** in the browser, **Edit link** using the same form, or **Remove link** while keeping the text. Removing an automatic link keeps its visible address without linking it again, including after sending; undo restores the link. These menus work when composing and editing messages.

Clicking outside closes the menu, including clicks inside the message field or code editor. **Cut**, **Copy** and **Copy link** display brief confirmation feedback. In the link form, addresses such as `www.google.com` or `example.com` automatically use HTTPS when the scheme is omitted; an explicit `http://` is preserved.

**Formatting options**, beside the emoji button, opens an inline toolbar. **Bold**, **italic**, and **strike** are toggles: without a selection, they enable or disable the effect for subsequent typing; with a selection, they change formatting without inserting placeholder text. `Ctrl+B` and `Ctrl+I` also work. Dividers group these controls and the lists. Lists and quotes can format existing lines or start in an empty field, with the caret after their marker. The link button opens a non-modal form above the button with **Text to display** and **Address**, prefilling the first field from the selection. Errors appear only after attempting to insert; `Escape` or clicking outside closes the form. `Escape` collapses the toolbar. The paperclip opens attachments. `Enter` sends or saves; `Shift+Enter` inserts a line and continues lists. Inside the code editor, `Enter` inserts a line and `Ctrl+Enter` (`Cmd+Enter` on macOS) sends or saves. Blank lines between passages are preserved in sent messages and copied text, just as in the preview.

To copy the **image**, rather than its file name or address, use **Copy image**
in the attachment controls or its right-click menu. Sticker menus also offer
this action. In the expanded viewer, use the copy button or `Ctrl+C`
(`Cmd+C` on macOS), with no text selected. The destination receives a PNG image
at its original size; animated images are copied as a static frame.
Copying supports up to 50 MB and 64 megapixels and reports unavailable images
or clipboard access instead of substituting a link.

In the expanded viewer, scroll over the image to zoom in or out. The image
and its container grow together instead of zooming inside a fixed crop.
Once it exceeds the window, drag to explore the details. Double-click toggles
between the initial fit and original size, up to 8× the initial fit; arrow keys navigate attachments
and `Escape` closes the viewer.

**Reply** keeps a reference to the original message with its author and preview. Replies support text, attachments, code and stickers; public bot messages can also receive replies. Cancel with the `×` in the composer or `Escape`. The reference stays with the channel draft. Clicking the preview jumps to the original, loading a history window if needed; **Back to latest messages** returns to recent conversation. Previews reflect edits and show **Message deleted** when the original is deleted, without retaining its content. Private bot messages cannot be referenced.

## Mentions

Typing `@` lists only members who can read the current channel, including offline members: pick someone to insert `@nickname`. Suggestions follow role and channel privacy changes. The server also checks manually typed mentions; members without access do not receive an unread mention. Whoever is mentioned gets the highlight on the message, the channel badge and the mention sound.

The first entry on the list is `@everyone` (or `@todos` — both tokens work in any language), which notifies everybody who can see that channel. Private channels stay private: people without access are not notified.

Server admins can turn this off under **Server settings → Notifications →
Allow everyone mention**, or through the CLI with `allowEveryoneMention`.
It is on by default.

## Bots and miniapps

Type `/` in a text channel to discover available commands. Bots can reply
privately, publish polls or open miniapps in the voice stage.
[Use bots](/en/bots) explains permissions, preferences and consent without
requiring programming.

## Code blocks

**Formatting options → Send a code block** and triple backticks create a code block **inside the draft**
without sending. Search and filter languages by name or alias (such as `js` or
`ps1`), edit or collapse a block, and interleave text
and multiple replies in the desired order. Each block can be removed. Pasted
Markdown fences also become editable blocks. Everything is sent together;
a failed send preserves the blocks for retry.

Older servers retain the code dialog, but confirming it inserts code into the
draft rather than sending immediately.

The editor and sent message show syntax highlighting and line numbers. In the
editor, `Tab` indents, `Shift+Tab` outdents, `Esc` focuses the language selector,
and `Ctrl+Enter` sends the composition. **Copy** copies only the code, without
line numbers or controls. The counter
includes the compatibility text's fences. References are validated by the server
and show **Message deleted** when their source is deleted.

For image- or sticker-only messages, **Copy message** and `Ctrl+C` without a
selection copy the image instead of its file name. Messages containing text
still offer that text; **Copy image** remains available separately.

## Emojis and stickers

The smiley button next to the message field opens a picker with **Emojis** and **Stickers** tabs. In the emoji category bar at the bottom, the clock icon takes you to **Recent**.

The **Recent** clock also appears in the reaction picker's category bar. Both share the last 32 distinct emojis selected on this device, newest first, even after restarting the app. Navigating categories or searching does not change the list; selecting an emoji again moves it to the front. Stickers are not included.

**Emojis** holds the full catalog, split by category and searchable (try `heart`, `party`, `cake`…). Clicking an emoji inserts it at the cursor, so you can mix emoji and text in the same message.

**Stickers** is where you pick a folder on your computer, the same way you do for the soundboard — either from the picker itself or in **Settings › Stickers**. Every `.png`, `.gif`, `.webp`, `.jpg`, `.apng` or `.avif` image up to 8 MB becomes a sticker; animated GIFs stay animated. Files over the limit show up dimmed, with the reason, instead of disappearing from the list. Clicking a sticker sends it right away as its own message, and everyone sees it as a fixed-size square.

The folder is re-read every time the picker opens, so adding or deleting files while the app is running just works. If you need to, the reload button (next to *Change Folder*) forces a fresh read.

Got a sticker from someone else? Hover over it and click the save button to copy it into your own folder.

The folder stays on your machine: the image is uploaded to the server when you use the sticker, like any other attachment. That is why sending a sticker requires the **Attach files** permission.

## Soundboard

The modal and sidebar show each playing sound, elapsed/total time and **Stop
sound playback**. Opening the modal does not play anything; closing it does
not interrupt normal playback. Stopping your own sound also notifies the call;
stopping someone else's sound only silences local playback.

In the grid or list, open an audio file's **vertical three-dot** button to access
**Edit**, **Rename audio** and **Delete audio**. **Edit** opens the trim and fade
editor. In the list, the button is at the far right, after the shortcut.
The menu supports keyboard navigation and closes with `Esc` or an
outside click without starting playback. Renaming and deletion change the actual file in your operating system
folder; deletion is permanent and requires confirmation. Favorites and shortcuts
follow the change. Existing names are never overwritten. If an old folder is
unauthorized, select it again using **Change folder**.

The editor displays the actual audio waveform: drag the upper handles to set
the trim start/end and the lower handles to adjust fade-in/fade-out. Times
are displayed alongside; no numeric entry is needed. With the keyboard, use
arrows for 0.01 s steps, `Shift` for 0.1 s and `Alt` for a single sample.
`Home`/`End` move to the limits and `Esc` cancels a drag. Shortening a selection
proportionally reduces fades that no longer fit, with a notice.
Each handle pair stays aligned; handles only separate vertically when they are
too close together, so neither covers the other.

The **Edited result · Only for you** player plays the final segment with trim
and fades applied, using the soundboard output, volume and limiter without
broadcasting to the call. Use **Play/Pause**, **Back to start**, **Stop** and
the position slider; a cursor follows playback on the waveform.
Pausing keeps the position; returning to the start does not resume paused audio.
Changing trim/fades resets the player so it cannot play a stale edit, and closing
the editor releases playback. Changing the copy name does not interrupt audio.
Only saving actions remain in the footer. **Save new audio** preserves the original and creates a 24-bit PCM
WAV at 48 kHz, keeping mono/stereo. **Overwrite original** requires confirmation
and retains the name, format, favorites and shortcuts. WAV requires no extra
tool; for other formats, prepare FFmpeg in **Settings › Bot tools**. Without
it, overwrite is blocked with an explanation, but saving a new WAV remains
available. Replacement happens only after generating and validating the result;
an external change to the original prevents overwrite. Re-encoding compressed
formats may introduce slight padding at the beginning/end of the audio.

The editor does not normalize or add other effects. `.mp3`, `.wav`, `.ogg`,
`.m4a`, `.aac` and `.webm` inputs depend on decoder support, in mono or stereo.
The editor imposes no artificial file-size or duration caps: files larger than
3 MiB or longer than 120 seconds can be opened, played and saved. Actual capacity
depends on available memory and the file format (WAV RIFF uses 32-bit sizes).
The limit for sending soundboard clips to a call remains separate and does not
restrict local editing. Unsupported formats and write failures display an error.

Monky prepares a local soundboard folder automatically. Under **Settings › Soundboard**, check its path or choose another folder containing `.mp3`, `.wav` or `.ogg`; existing folder selections are preserved. In the call, play sounds from the soundboard button. Volume and local mute live in the same settings. The host can disable the soundboard for the whole server and, under **Server Settings › Roles**, grant the **Use soundboard** permission only to the desired roles.

Use stars and the **All/Favorites** filter together with search to find sounds,
with favorites first and alphabetical order within each group, without changing
the shortcuts assigned to sounds. Starring does not play the sound.
The same ordering applies to Home's saved-server list.
