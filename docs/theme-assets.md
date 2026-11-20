# Theme artwork

The backdrops, paper grain and stickers of the Arène, Récif and Papeterie
themes were generated with Adobe Firefly from the prompts below, then
converted to WebP. No image contains a logo, a brand, a title, text or a
recognisable character, and none was traced from an existing work.

To replace an image, overwrite the WebP with the same name; nothing else
changes.

Rules for every image:

- No logo, no title, no text, no recognisable character. Firefly's "avoid"
  field gets: `text, logo, watermark, letters, brand, UI, HUD`.
- 16:9, at least 2560×1440, exported as WebP (quality ~80) to keep each file
  under ~400 KB. Name the files exactly as below. (The current backdrops are
  1376×768.)
- The app's panels sit on top of the image, so it must stay calm: low detail
  in the centre, contrast kept down.

## Arène — `client/src/styles/themes/pocket-art/`

Variable: `--pl-arena` in `pocket.css` (one value per mode).

### `arena-night.webp` (dark mode)

> Wide-angle view from pitch level inside an empty futuristic indoor football
> stadium at night, heavily blurred background with strong depth of field,
> deep navy blue and electric blue palette, rows of blue stadium seats in two
> tiers, bright white floodlights and lens flares along the roof truss, dark
> glossy artificial pitch in the foreground with one faint glowing blue
> touchline crossing diagonally, low contrast, cinematic, soft bokeh, no
> people, no text, no logos, no cars.

Style: Photo, or "Art" at low stylisation. Aspect 16:9.

### `arena-day.webp` (light mode)

> Same futuristic indoor football stadium in daylight, heavily blurred, pale
> sky blue and white palette, translucent roof letting in soft daylight, light
> blue stadium seats in two tiers, bright airy atmosphere, pale pitch in the
> foreground with one faint blue touchline crossing diagonally, very low
> contrast, soft bokeh, no people, no text, no logos, no cars.

## Récif — `client/src/styles/themes/waterraria-art/`

Variable: `--wr-scene` in `waterraria.css` (one value per mode). Bubbles keep
drawing over the image.

### `ocean-abyss.webp` (dark mode)

> 2D side-view pixel art scene of a deep ocean, 16-bit retro game style, crisp
> hard pixel edges, limited palette of deep navy, dark teal and midnight blue,
> faint diagonal light shafts coming down from the surface at the top, sandy
> sea floor at the very bottom with small kelp stalks and pink coral, a few
> distant small fish silhouettes, large calm empty dark water area in the
> centre, no characters, no text, no user interface.

Style: "Art", pixel art. Aspect 16:9. If Firefly smooths the pixels, generate
at a smaller size and upscale with nearest-neighbour (any image editor's
"pixel art" or "nearest" resampling) to 2560×1440.

### `ocean-shallows.webp` (light mode)

> 2D side-view pixel art scene of a tropical shallow sea, 16-bit retro game
> style, crisp hard pixel edges, bright turquoise and light cyan water, sky
> visible above a pixel wave line at the very top, sunlight shimmering on the
> water, white sandy floor at the bottom with green kelp, pink and orange
> coral and a few shells, large calm empty light water area in the centre, no
> characters, no text, no user interface.

## Not asked of Firefly: the icons

Pixel icons need a fixed 16×16 grid and transparent background, which image
generators handle poorly. The Cristal theme's icon set (`styles/themes/vista-icons/`,
one SVG per `data-icon`) is the model: a Récif set would be drawn the same
way, by hand in SVG, pixel by pixel.

## Papeterie — `client/src/styles/themes/tiddl-art/`

Generated in Firefly, then converted: backdrops at 1376×768, WebP q80; paper
cropped to its centre, greyed, flattened to near white (mean 252/255) and
made seamless with a half-offset blend, 512×512; stickers trimmed to their
outline and resized to 256 px on the long side.

Same rules as above, plus one: no animal and no mascot of any kind. Ask for
the aspect ratio in the prompt itself, and re-roll rather than edit when
text appears.

Palette to keep across all images: sky blue `#cfe9fb`, cream `#fffaf0`,
cheese yellow `#ffd34d`, candy pink `#ff9ec7`; night: indigo `#17153a`.

### Backdrops — variable `--td-scene` (one per mode)

Shipped as WebP, ~2560×1440, quality ~80. Calm centre: panels cover it.

`sky-day.webp` (light mode)

> Soft pastel children's stationery illustration, 16:9. A pale sky-blue sky
> with fluffy cream clouds along the bottom edge, tiny hand-drawn yellow stars
> and pink hearts scattered sparsely near the corners, gentle watercolour
> texture. Large empty calm area in the middle. No animals, no characters, no
> text, no letters, no logo.

`sky-night.webp` (dark mode)

> Same pastel stationery style, 16:9. Deep indigo night sky, a crescent moon
> in the top-right corner, small cream and warm yellow hand-drawn stars,
> soft lilac clouds along the bottom edge, faint watercolour grain. Large
> empty calm area in the middle. No animals, no characters, no text, no logo.

### Paper grain — variable `--td-paper` (both modes)

`paper.webp`, 512×512, tiled. Light mode multiplies it over cream, dark mode
lays it in soft-light over indigo, so it must be **near white and neutral**.

> Seamless tileable texture of plain off-white writing paper, square, very
> subtle fibres and tiny light-grey speckles, flat even lighting, no lines, no
> grid, no shadows, no vignette, no text.

Image generators do not guarantee a seamless tile. If the edges show a seam,
fix the tile with a half-offset blend, or switch it to a single stretched
layer.

### Stickers — four small decorations

Each one alone in its image, square, then **background removed** (Adobe
Express "Remove background", or any equivalent) and exported as WebP with
transparency, 256×256. The flat grey background in the prompts is only there
to make that removal clean.

Placement: cheese at the foot of the
folder pane next to the paw prints; star beside the app name; heart on the
title strip of a new message; envelope in the empty reading pane.

`sticker-cheese.webp`

> Cute die-cut sticker of a single wedge of yellow cheese with round holes,
> thick white sticker border, soft pastel cartoon style, thin brown outline,
> centred on a flat plain mid-grey background, square. No face, no animal,
> no text.

`sticker-star.webp`

> Cute die-cut sticker of one chubby five-pointed yellow star with rounded
> tips and a small shine, thick white sticker border, pastel cartoon style,
> centred on a flat plain mid-grey background, square. No face, no text.

`sticker-heart.webp`

> Cute die-cut sticker of one plump candy-pink heart with a small white
> shine, thick white sticker border, pastel cartoon style, centred on a flat
> plain mid-grey background, square. No face, no text.

`sticker-envelope.webp`

> Cute die-cut sticker of a closed cream envelope sealed with a small pink
> heart, a tiny yellow star stamp in the corner, thick white sticker border,
> pastel cartoon style, centred on a flat plain mid-grey background, square.
> No animal, no text, no letters on the envelope.
