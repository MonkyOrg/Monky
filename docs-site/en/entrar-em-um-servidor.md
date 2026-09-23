# Join a Server

The **Join Server** tab offers four routes.

<AppScreenshot src="/screenshots/inicio-en.png" alt="Monky's home screen with connection options and server fields." caption="The address and port must point to the process hosting the server." />

## Invitation link

Paste the link under **Join with an invitation** and click **Review invitation**,
or open the received HTTPS link in your browser. The official page attempts
to open the installed app using `monky://` and offers buttons to open, copy
or download Monky. Your browser may ask for confirmation. For development or
portable runs, paste the link into the app; local testing does not register a
global protocol handler on your system.

The short link uses the homepage itself, in the form
`https://monkyorg.github.io/Monky/#~...`; direct app opening uses
`monky://#~...`. The part after `#~` contains the complete connection data in
binary form, with lossless compression when it reduces the size. There is no
shortener, registered code or central service needed to resolve the invitation:
the app reads the link itself, even without loading the website.

Review the name, address and port, then click **Join**. Monky automatically
uses your current identity name, without asking you to enter it again.
A nickname field only appears when the identity or its name has not been set.
Received links never connect on their own or close your other sessions or
current call. An already connected server reuses its session without replacing
saved credentials.

To generate a link, open **Invite Friends** on the server and copy the invitation.
It **omits the password by default**. The **Include password in invite** switch
uses the password the client already knows, without asking you to type it again.
When the password is unavailable, the link still works without it: recipients
enter it if the server requires one.
With the password included, recipients do not need a separate address, port
or password: just the invitation and confirmation in the app.

Data stays in the fragment after `#`, not in an HTTP query to the website.
This is encoding, not encryption: anyone with a password-bearing invitation
can use that password. The HTTPS certificate belongs to the official website;
you do not need a certificate on your server to share the link. Invitations
do not change the server transport or configure ports, VPNs or firewalls.

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

The **Home** button (the house at the top of the column) opens the start screen
without disconnecting servers or ending the call. The rail lets you reopen
a connection, and the bottom controls remain available. **Disconnect** in the
bottom bar leaves only the server named in its tooltip, after confirmation.
Monky then opens the next connected server; if none remains, it shows Home.

## Several devices at once

You can join the same server from more than one computer using the same identity — your desktop and your laptop, for instance. Each device shows up as its own entry in the voice list, with a `(2)`, `(3)` suffix to tell them apart, yet you remain a single person in the member list and take up only one server slot.

A few details worth knowing:

- Audio between **your own** devices is dropped automatically so it cannot cause feedback. Camera and screen sharing still work normally between them.
- Personal mute and individual volume are device controls. An administrative microphone/audio restriction applies to your identity on that server, including the other devices; kicking from the server disconnects all of them.
- The limit is **3 simultaneous devices** per person.

If anything fails, see [Troubleshooting](/en/solucao-de-problemas).
