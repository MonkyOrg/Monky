# Join a Server

The **Join Server** tab offers three routes.

<AppScreenshot src="/screenshots/inicio-en.png" alt="Monky's home screen with connection options and server fields." caption="The address and port must point to the process hosting the server." />

## Servers on the Network

Click **Scan**. For about 5 seconds the app listens for Monky servers on the local network and lists name, IP and version. Click **Join**.

## Saved Servers

Every server you join is saved. The dot shows whether it is **online** or **offline**, and the list shows who is connected. Use **Use** to fill in the fields or **X** to remove it.

## Manual entry

Fill in **Your Nickname**, **Server IP / Host**, **Port** (usually `3000`) and **Server Password** if one exists. Then click **Join Server**.

## Several servers at once

Once you are in, the icon column on the left lists your servers. Clicking one takes you there **without disconnecting from the previous one**: the old connection stays alive in the background.

In practice that means:

- **Your voice call does not drop when you switch servers.** While it is running on another server, that server's icon in the left column gets a green audio marker.
- **Messages arriving on a background server are received normally** and put a dot on its icon. The app plays no sound in that case — the alert would be about a conversation you are not looking at.
- **Going back to a server you are already connected to is instant**, with no new authentication and no loading screen.

You talk on one server at a time, because there is only one microphone: joining a voice channel on another server **moves the call** and takes you out of the previous channel automatically. Text chat, on the other hand, stays active everywhere at once.

The **Home** button (the house at the top of the column) asks for confirmation
before disconnecting from every server, including the active call. Switching
the viewed server and confirming this exit are different actions.

## Several devices at once

You can join the same server from more than one computer using the same identity — your desktop and your laptop, for instance. Each device shows up as its own entry in the voice list, with a `(2)`, `(3)` suffix to tell them apart, yet you remain a single person in the member list and take up only one server slot.

A few details worth knowing:

- Audio between **your own** devices is dropped automatically so it cannot cause feedback. Camera and screen sharing still work normally between them.
- Personal mute and individual volume are device controls. An administrative microphone/audio restriction applies to your identity on that server, including the other devices; kicking from the server disconnects all of them.
- The limit is **3 simultaneous devices** per person.

If anything fails, see [Troubleshooting](/en/solucao-de-problemas).
