# Privacy notice: Goldsmiths Site & AI Builder 1.2.5

Publisher: G-Lock Ltd. This is the same text the app serves at `/privacy`.

```
Goldsmiths Site & AI Builder - what happens to your data

Everything you type is stored on this NAS and nowhere else. There is no account,
no login, no analytics and no tracking of any kind.

WHAT IS STORED, and where
  sites/<name>/        the site name, the brief you typed, and the page the AI wrote
  uploads/<session>/   pictures and documents you add, plus any picture the app generates
  orders/              domain orders you start: the domain, the price, and the contact
                       details you enter (name, email, and any address you give)
All of it lives under the app's data volume. Deleting the app's volumes deletes all of it.

WHAT LEAVES THE NAS
The AI that writes the site runs in a container beside this app, on this NAS

Three optional features do talk to other services, and only when they are switched on:

  1. Looking up whether a domain is free.
     Always on, because it only asks a public registry about a name you typed.
     Sends: the domain name. To: rdap.verisign.com (for .com and .net) or
     rdap.nominet.uk (for .uk). No personal data is sent.
     If GODADDY_KEY and GODADDY_SECRET are set, the lookup goes to api.godaddy.com
     instead, sending the domain name and those credentials.

  2. Generating a picture. Only works if IMAGE_API_URL is set.
     Sends: the picture description you typed, to the address in IMAGE_API_URL.
     If that address points at a service on the internet, your description leaves this NAS;
     if it points at a box on your own network, it does not. The app does not care which,
     so read that setting before relying on it.

  3. Buying a domain. Only works if STRIPE_SECRET_KEY is set.
     Sends: the domain, the price, and the name and email you entered, to api.stripe.com,
     so that Stripe can take the payment. Card details are typed on Stripe's page and never
     reach this NAS. Stripe's own privacy policy covers what Stripe then keeps.

WHAT NEVER HAPPENS
No telemetry, no usage reporting, no advertising, no sharing of your sites or documents
with G-Lock Ltd or anyone else. The app makes no other outbound connections.

YOUR RIGHTS: SEE IT, TAKE IT, DELETE IT
  see      GET    /api/my-data            a summary, plus every site record
  take     GET    /api/my-data/export     one JSON file: your pages and your orders
  fix      edit the site by building it again with the same name; it replaces the old copy
  delete   DELETE /api/my-data/site/<name>  remove one site
           DELETE /api/my-data              remove every site, upload and order
  erase everything: uninstall the app and delete its volumes.
You do not have to ask us for any of this, and we cannot do it for you: the data is
on your hardware, not ours.

Publisher: G-Lock Ltd. Contact: privacy@goldsmiths.ai
Receipts and rights questions: https://goldsmiths.ai/privacy
```

Contact: privacy@goldsmiths.ai
