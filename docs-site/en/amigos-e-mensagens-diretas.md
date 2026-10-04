# Friends and direct messages

Friends and direct messages (DMs) live on **Home**. Monky has no central
server: each person keeps their own copy of the conversations, and the servers
you both are on only carry the messages.

## Add a friend

1. Join a server the other person is also on.
2. Right-click their name (member list, chat or voice channel).
3. Choose **Add friend**.

The request shows up under **Friends → Pending** for both of you. The
recipient sees **Accept** and **Decline**; the sender can **Cancel** until the
request is accepted. Declining is silent: the request only disappears for the
person who declined.

If the other person is offline, the request stays on your computer and is
delivered when you meet on a common server.

## Friends page tabs

| Tab | What it shows |
| --- | --- |
| Available | Friends online on some server you are also connected to |
| All | Your whole friend list |
| Pending | Sent and received requests |
| Blocked | Blocked people (shown when there is any) |

Click a friend to open the conversation. The **⋮** button and right-click
offer **Send message**, **Remove friend** and **Block**.

## Chat

The conversation opens in the middle of Home, and the **Direct messages** list
on the left shows the last message, the unread counter and whether the person
is online. A conversation's **X** only removes it from the list; it comes back
when a new message arrives.

DMs support formatting, emojis, replies, editing, deleting, reactions and
attachments. Monky shows when the other person is typing. Consecutive
messages from the same person on the same day are grouped under a single name
and picture; hover one to see its time. A message that has not been delivered
yet appears semi-transparent and turns solid once it reaches your friend.
Server channels work the same way: a message is semi-transparent while it is
being sent.

::: info Delivery when you meet
A message is only transmitted while you are both online on at least one common
server. Until then it stays on your computer, semi-transparent, and is sent
automatically later. **Appear offline** still receives DMs without
revealing your presence.
:::

New messages play a sound, show a notice and add to a counter on the rail's
**Home** button, together with received friend requests.

## Privacy

- Messages and files are **end-to-end encrypted**: only you and your friend
  can read them.
- The server only relays the encrypted data and **stores nothing**. It also
  does not tell third parties who you talk to.
- History is saved, encrypted, only on your two computers.
- A server owner can turn off DM relaying in
  [Server Settings](/en/administrar-servidor#direct-messages).

## Files

Files and images travel directly between you, through the common server, while
you are both online. Each person picks the largest size they accept in
**Settings → My Profile → Direct messages** (50 MB by default). If a file is
over your friend's limit, Monky warns you before sending.

## Remove friend and block

- **Remove friend** ends the friendship for both of you. The history stays on
  your computer, read-only.
- **Block** also removes the friendship and stops new requests and messages
  from that person. They are not notified. Unblock under
  **Friends → Blocked**.

## Other devices and backup

When exporting the identity under **Settings → My Profile → Identity**, choose
whether the export brings your **Friends** and, optionally, the
**Conversation history**. History can make the code too large for the QR code;
in that case, save the file.

When the same identity is on more than one computer, Monky syncs between them
the friend list, the conversation history (including edits, deletions,
reactions and what has been read), plus your nickname and picture. The most
recent nickname and picture apply on every computer and are also what your
friends see in DMs. The picture travels as a reduced copy.

::: info Both computers need to meet
Like messages, syncing goes through servers and is not stored on them. It
happens while both computers are open at the same time, connected to at least
one common server. Whatever one of them did while the other was off reaches
the other the next time both are online together.
:::
