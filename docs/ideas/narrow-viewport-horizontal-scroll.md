# Horizontal scroll at a 400px viewport

At a 400px viewport the page scrolls horizontally on 30d and All. The document is 416px
wide. The cause is `#modelMixPanel`. It predates the Setup changes work and was found
while checking that panel on 2026-10-10.

## Possible fix

Find which element in `#modelMixPanel` sets the minimum width, and let it shrink or wrap.
