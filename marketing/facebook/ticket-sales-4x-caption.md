# Facebook Post — Ticket Sales 4× Higher

**Image:** `ticket-sales-4x-post.png` (1080×1080, square — ideal for the Facebook feed)

## Ready-to-paste caption

> 🤠 Don't be disappointed, folks! Ticket sales are over **4× higher** than this time last year — and they're going fast. 🎟️
>
> To avoid overcrowding and make sure everyone has a fantastic time, we're limiting sales to **3,000 people per day**. Once a day sells out, it's gone!
>
> 👉 Get yours today at holmdalerodeo.ca and make sure you don't miss out.
>
> #HolmdaleProRodeo #WalkertonOntario #Rodeo #BruceCounty #SupportLocal

## Posting tips

- Attach the image and paste the caption as the post text — don't put the link in the image-only field, keep it in the caption so it's clickable.
- Best posting windows for event pages: weekday evenings (6–9 PM) or Saturday morning.
- Pin the post to the top of the page while the sales push is on.

## Regenerating the image

The source is `ticket-sales-4x-post.html`. Open it in a browser (needs internet
for Google Fonts) and screenshot the 1080×1080 canvas, or render headless:

```bash
chromium --headless --no-sandbox --hide-scrollbars \
  --window-size=1080,1200 --screenshot=post.png ticket-sales-4x-post.html
# then crop to the top 1080×1080
```
