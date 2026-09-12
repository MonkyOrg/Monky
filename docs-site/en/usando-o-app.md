# Using the App

## Voice

Click a **voice channel** to join the call. Whoever speaks gets a green ring around the avatar. The bottom bar has microphone, headphones/deafen and disconnect. The panel shows average ping and lets you leave only the call.

Right-click a participant to adjust their individual volume. The setting applies only on this computer and to that device: if the same person is connected from two machines, each one gets its own volume.

The call follows you: switching servers in the left column keeps it running, and the icon of the server hosting it stays marked. Joining a voice channel on another server moves the call there. See [Several servers at once](/en/entrar-em-um-servidor#several-servers-at-once).

## Camera and screen

On the media bar: **Camera**, **Share Screen** and **Soundboard**. Screen sharing lets you choose a whole screen or a specific window, with screen audio sent to participants.

Under **Settings → Voice and Video → Camera**, preview blur, color or image
virtual backgrounds and physical-screen chroma key. Effects run locally and
also apply to the call. Closing the preview does not stop a camera in use;
see limitations and precautions in [settings](/en/configuracoes).

Whoever broadcasts shows a **LIVE** badge. Click the card to spotlight it or use fullscreen.

## Chat

Each text channel has history saved on the server, avatars, timestamps, basic formatting and an anti-flood limit of 10 messages every 5 seconds.

A message you started but haven't sent stays with the channel you were typing in. Jumping to the voice stage, opening another channel and coming back does not wipe the text — each channel keeps its own draft, which only goes away when you send the message or leave the server.

Hover over a message (or reach its buttons with `Tab`) to reveal a floating toolbar with **Emoji**, **Reply**, **Copy message** and **More options**. The three-dot menu displays full action names; **Edit message** is only available to the author when the server permits editing, and **Delete message** to the author or moderators. Navigate menus with arrow keys and close them with `Escape`.

**Reply** keeps a reference to the original message with its author and preview. Replies support text, attachments, code and stickers; public bot messages can also receive replies. Cancel with the `×` in the composer or `Escape`. The reference stays with the channel draft. Clicking the preview jumps to the original, loading a history window if needed; **Back to latest messages** returns to recent conversation. Previews reflect edits and show **Message deleted** when the original is deleted, without retaining its content. Private bot messages cannot be referenced.

## Mentions

Typing `@` in the message box opens the member list: pick someone to insert `@nickname`. Whoever is mentioned gets the highlight on the message, the channel badge and the mention sound.

The first entry on the list is `@everyone` (or `@todos` — both tokens work in any language), which notifies everybody who can see that channel. Private channels stay private: people without access are not notified.

Server admins can turn this off under **Server settings → General → Allow everyone mention**, or through the CLI with the `allowEveryoneMention` key. It is on by default.

## Code blocks

The `< >` button, next to the smiley, opens a window for pasting code. Pick the language from the list (or leave it on *Plain text*) and send it with the button or with `Ctrl+Enter`.

Inside the window `Tab` indents instead of jumping to the next field, and `Shift+Tab` removes the indentation. With several lines selected it applies to all of them at once.

In the chat the code shows up in a highlighted block, with the language name on top and a **Copy** button that puts the snippet on the clipboard without any formatting. The window's counter already includes the block markers, so it shows the real size of the message that will be sent.

You can also type it straight into the message field: wrapping the snippet in three backticks (```` ``` ````) does the same, and writing the language right after the first backtick (for example ```` ```python ````) turns syntax highlighting on.

## Emojis and stickers

The smiley button next to the message field opens a picker with **Emojis** and **Stickers** tabs. In the emoji category bar at the bottom, the clock icon takes you to **Recent**.

The **Recent** clock also appears in the reaction picker's category bar. Both share the last 32 distinct emojis selected on this device, newest first, even after restarting the app. Navigating categories or searching does not change the list; selecting an emoji again moves it to the front. Stickers are not included.

**Emojis** holds the full catalog, split by category and searchable (try `heart`, `party`, `cake`…). Clicking an emoji inserts it at the cursor, so you can mix emoji and text in the same message.

**Stickers** is where you pick a folder on your computer, the same way you do for the soundboard — either from the picker itself or in **Settings › Stickers**. Every `.png`, `.gif`, `.webp`, `.jpg`, `.apng` or `.avif` image up to 8 MB becomes a sticker; animated GIFs stay animated. Files over the limit show up dimmed, with the reason, instead of disappearing from the list. Clicking a sticker sends it right away as its own message, and everyone sees it as a fixed-size square.

The folder is re-read every time the picker opens, so adding or deleting files while the app is running just works. If you need to, the reload button (next to *Change Folder*) forces a fresh read.

Got a sticker from someone else? Hover over it and click the save button to copy it into your own folder.

The folder stays on your machine: the image is uploaded to the server when you use the sticker, like any other attachment. That is why sending a sticker requires the **Attach files** permission.

## Soundboard

Under **Settings › Soundboard**, choose a folder containing `.mp3`, `.wav` or `.ogg`. In the call, play sounds from the soundboard button. Volume and local mute live in the same settings. The host can disable the soundboard for the whole server and, under **Server Settings › Roles**, grant the **Use soundboard** permission only to the desired roles.

Use stars and the **All/Favorites** filter together with search to find sounds,
with favorites first and alphabetical order within each group, without changing
the shortcuts assigned to sounds. Starring does not play the sound.
The same ordering applies to Home's saved-server list.
