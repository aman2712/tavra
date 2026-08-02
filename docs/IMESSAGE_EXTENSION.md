# Tavra Messages extension

## Status

The repository now contains a production-oriented native scaffold in
`ios/TavraMessages`, backed by a separately testable pure-Swift package in
`ios/TavraMessagesCore`. The Tavra server now creates the Linq `imessage_app`
payload and updates the delivered card after the Prava result. It enables that
path only when the matching Apple identity is configured. A real card becomes
interactive after all of these are true:

1. The generated app is signed with an Apple Developer team and installed on
   the recipient's iPhone or iPad.
2. Linq sends an `imessage_app` part whose `team_id` and extension `bundle_id`
   exactly match that installed build.
3. The card URL is an HTTPS Tavra `/pay/{checkoutId}` capability URL on the one
   exact host compiled into the extension.

Recipients without the installed extension continue to see Linq's static card
layout. This is an Apple/Linq platform requirement, not something a server
prompt or payload can bypass. See [Apple's Messages framework](https://developer.apple.com/documentation/messages)
and [Linq's iMessage Apps guide](https://docs.linqapp.com/guides/messaging/imessage-apps/).

## What the scaffold does

When a person taps an installed Tavra app card, `MessagesViewController`:

1. Reads the selected `MSMessage.url`.
2. Accepts only `https://{exact-allowlisted-host}/pay/{20-to-128-character-base64url-id}`.
3. Rejects credentials, query strings, fragments, custom ports, sibling hosts,
   subdomains, wildcard hosts, and malformed IDs.
4. Fetches the same-origin redacted summary from
   `/api/prava/checkouts/{id}/summary` using an ephemeral, no-cookie, no-cache
   URL session.
5. Displays the itemized checkout, total, and optional product thumbnails as
   native UIKit. Thumbnail URLs must use the same exact Tavra origin and the
   `/checkout-assets/products/{safe-filename}` path; redirects and arbitrary
   merchant image hosts are rejected.
6. Presents the existing HTTPS Tavra/Prava approval page in a modal
   `SFSafariViewController`, so the user remains in the Messages experience
   while the payment ceremony stays in a Safari-controlled surface.
7. Polls the sanitized same-origin status endpoint while the extension is
   active and distinguishes pending, simulated, live, failed, and
   reconciliation-required outcomes.

The summary endpoint intentionally excludes the Prava publishable key, Prava
session token, iframe URL, secret key, network token, dynamic CVV, address, phone
number, and baggage evidence. The opaque checkout ID is still a bearer
capability: do not log it, add it to analytics, or place it in screenshots.

## Why Tavra does not put Prava in a `WKWebView`

The scaffold deliberately does not embed the Prava iframe or implement card
fields itself. Apple documents that passkeys in `WKWebView` require the app to
configure the relying-party domain as an Associated Domain. That also requires
the relying party to authorize Tavra's signed app through its associated-domain
file. Prava owns that relying-party origin, and its cross-origin iframe/WebAuthn
behavior has not been certified for a Tavra Messages extension. See
[Apple's passkey guidance](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys).

Prava's current documentation also makes an important distinction: its embedded
mode can keep the initial PCI card iframe inside an application's web page, but
the final passkey verification runs on the card network's own hosted page. That
visible network origin is an intended security boundary. Tavra's installed
`@prava-sdk/core` 0.1.2 runtime handles Prava redirect events as top-level
navigation and exposes no redirect override or native passkey API.

`SFSafariViewController` is therefore the safer bridge. It displays the working
hosted approval in a Safari-controlled modal without letting the extension
inspect card or verification content. Until Prava certifies Tavra's Associated
Domains and WebAuthn context, do not replace this with `WKWebView` and do not
claim "payment inside the bubble." The accurate description is "native order
review inside Messages, followed by secure Prava and card-network approval in a
Safari-controlled modal."

See the full [Prava and live commerce audit](./PRAVA_AND_COMMERCE_AUDIT.md).

## One-time project setup

Install XcodeGen and create the local, untracked build configuration:

```bash
brew install xcodegen
cp ios/TavraMessages/Config/Local.xcconfig.example \
  ios/TavraMessages/Config/Local.xcconfig
```

Edit `ios/TavraMessages/Config/Local.xcconfig`:

```xcconfig
TAVRA_APP_BUNDLE_ID = com.yourcompany.tavra
TAVRA_MESSAGES_BUNDLE_ID = com.yourcompany.tavra.MessagesExtension
TAVRA_DEVELOPMENT_TEAM = A1B2C3D4E5
TAVRA_CHECKOUT_HOST = your-current-tunnel-host.example
```

Important:

- `TAVRA_DEVELOPMENT_TEAM` is the 10-character Apple team ID, not an Apple ID
  email address.
- Both bundle IDs must be registered to that team and use automatic or valid
  explicit signing.
- `TAVRA_CHECKOUT_HOST` is only the hostname. Do not include `https://`, a path,
  a wildcard, or a trailing slash.
- A new dev-tunnel hostname requires editing this value and rebuilding the
  extension. This is intentionally fail-closed.
- Never add a Linq key, Prava key, OpenAI key, session token, test card, or CVV to
  an `.xcconfig`, plist, Swift source file, or app entitlement.

Generate and open the project:

```bash
bash ios/TavraMessages/generate-project.sh
open ios/TavraMessages/TavraMessages.xcodeproj
```

The generator fails closed when the local file is missing, still contains an
example value, or has a malformed team ID, bundle ID, or checkout hostname.

Configure the Tavra server with the exact same extension identity in `.env`:

```dotenv
TAVRA_MESSAGES_APP_TEAM_ID=A1B2C3D4E5
TAVRA_MESSAGES_APP_BUNDLE_ID=com.yourcompany.tavra.MessagesExtension
TAVRA_MESSAGES_APP_NAME=Tavra
# Add this only after App Store publication.
TAVRA_MESSAGES_APP_STORE_ID=
```

Leave `TAVRA_MESSAGES_APP_TEAM_ID` empty until the signed extension is actually
installed. Tavra then deliberately sends the ordinary rich-link fallback.

In Xcode:

1. Open **Xcode > Settings > Accounts**, add the Apple ID that owns your Apple
   development team, and let Xcode download its signing information.
2. Connect and unlock the iPhone, trust this Mac when prompted, and select the
   phone as the run destination. If iOS asks, enable **Developer Mode** under
   **Settings > Privacy & Security**, restart, and reconnect.
3. Select the `TavraMessages` project.
4. Confirm the same Apple team and intended bundle IDs for the containing app
   and `TavraMessagesExtension` target.
5. Add final App Store and iMessage app icon catalogs before distribution.
6. Select the `TavraMessages` scheme and the physical iPhone or iPad.
7. Press **Run** once to sign and install the containing Messages app. Accept a
   local developer-profile trust prompt on the phone if iOS presents one.
8. In Messages, open the apps drawer, choose **More**, and enable Tavra if it is
   not already visible.

The iOS Simulator can compile and exercise layout, but an end-to-end Linq card,
Apple account, Prava passkey, and biometric run must be verified on a signed
physical device.

## Linq card identity

After the native build is installed, Tavra's server-side Linq sender uses this
same identity. This is a separate message because an iMessage app part cannot
share a bubble with text. The implemented payload is equivalent to:

```ts
await client.chats.messages.send(chatId, {
  message: {
    parts: [{
      type: "imessage_app",
      app: {
        name: "Tavra",
        team_id: "A1B2C3D4E5",
        bundle_id: "com.yourcompany.tavra.MessagesExtension",
        // Add app_store_id only after the containing app is published.
      },
      url: checkout.url,
      fallback_text: "Review Tavra recovery approval",
      interactive: true,
      layout: {
        caption: "Tavra recovery",
        subcaption: "Review items and approve securely",
        trailing_caption: "$154.00",
        trailing_subcaption: "Sandbox",
      },
    }],
  },
});
```

Linq uses the Apple team ID plus extension bundle ID as the rendering key. An
unrecognized or uninstalled identity silently falls back to the static layout.
Before sending, check that the recipient is iMessage-capable. An iMessage app
part cannot be sent over SMS or RCS and must be the only part in its message.

## Tests and builds

Run the pure-Swift trust-boundary tests:

```bash
swift test --package-path ios/TavraMessagesCore
```

They cover exact-host HTTPS validation, same-origin endpoint construction,
malformed URL rejection, summary binding, and every sanitized payment status.

After generating the project, compile without signing:

```bash
xcodebuild \
  -project ios/TavraMessages/TavraMessages.xcodeproj \
  -scheme TavraMessages \
  -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO \
  build
```

Run the Node route test as part of the normal suite:

```bash
npm test
```

That test asserts the extension summary contains the expected order while
excluding browser session state and payment credentials.

## Physical-device acceptance test

1. Start Tavra and its public HTTPS tunnel with `npm run dev:imessage`.
2. Confirm the hostname exactly matches `TAVRA_CHECKOUT_HOST` in the installed
   extension build.
3. Install the signed Messages app on the test iPhone.
4. Ensure the server `.env` has the same team and extension bundle IDs, restart
   `npm run dev:imessage`, and complete a recovery flow so Tavra sends the Linq
   `imessage_app` checkout card.
5. Confirm the static bubble shows the Tavra summary and tapping it opens the
   native extension rather than plain fallback text.
6. Confirm the extension shows only items, quantities, same-origin product
   thumbnails, total, and sanitized state. Inspect device logs and verify no
   session token, card value, CVV, or Prava secret appears.
7. Tap **Continue securely with Prava**. Confirm the hosted page appears within
   the Safari-controlled modal and the extension cannot inspect or alter it.
8. Complete the Prava sandbox approval with Face ID or the sandbox ceremony.
9. Return to the extension and confirm it shows **Sandbox approval complete**
   plus the explicit statement that there is no live merchant order.
10. Confirm Tavra also posts the truthful result in the original chat.
11. Repeat with an expired card, wrong host, lookalike subdomain, altered ID,
    revoked checkout, Prava failure, and reconciliation-required result.

Do not record real phone numbers, checkout IDs, email addresses, addresses,
card details, baggage references, or passkey screens in the hackathon video.

## Apple platform limitations

- A backend cannot remotely install an iMessage app. The signed containing app
  must be installed through Xcode, TestFlight, or the App Store.
- Recipients without the exact installed extension see only the static Linq
  card/fallback. `app_store_id` can add a **Get the app** affordance only after
  publication.
- Messages extensions are aggressively suspended and terminated. Native UI
  polling is convenience UX only; the Tavra server remains the source of truth
  and must deliver the durable same-chat outcome.
- A card is iMessage-only and cannot share a bubble with text, media, or a rich
  link. Send conversational copy separately.
- Updating a delivered Linq card requires retaining its delivered message ID
  and calling Linq's app-card update endpoint. A 409 before delivery must be
  retried after `message.delivered`.
- Tavra currently retains the checkout-to-card message ID in process memory.
  Production deployment still needs a durable mapping and delivery-aware retry
  queue so a restart or early 409 cannot lose a card update.
- The user must perform a recent, explicit interaction for sensitive UI. Do not
  attempt to auto-launch payment or auto-trigger passkey approval when a message
  merely arrives.
- `SFSafariViewController` is a secure handoff, not a mutable native payment
  form. Tavra cannot style Prava's protected fields or read their contents.
- Shipping requires final icon assets, registered bundle identifiers, signing,
  privacy disclosures, App Store review, and a real-device accessibility test.
