# NEBULA — Ultimate Static Anime Streaming Frontend

Premium Netflix × Spotify inspired anime SPA built with **HTML5 + Tailwind CSS CDN + Vanilla JavaScript**. It is completely static and can be deployed directly to Vercel with no build step.

## Included features

- AniList GraphQL metadata, covers, banners, scores, genres, studios and air schedules
- Dynamic hero spotlight with autoplay and keyboard navigation
- Trending, currently airing, popular, top-rated and upcoming catalog rows
- Genre discovery pages and genre filtering pills
- Debounced search modal with recent searches and pagination
- Keyboard-first navigation (`/`, `Esc`, `←`, `→`, focused-card Enter/Space)
- Persistent My Watchlist using browser localStorage
- Persistent viewing history and **Continue watching** row
- Per-episode watched/unwatched state stored locally
- Resume buttons that remember the last opened episode
- Anime details pages with metadata, tags, characters, relations and recommendations
- Episode grids with watched-state indicators
- Responsive watch/player page
- Previous/next episode controls
- Custom streaming-provider adapter in one clearly marked configuration block
- Settings modal for autoplay, reduced motion, glass blur and compact cards
- One-click local search-history reset and library reset
- Loading skeletons and failure states
- Responsive mobile/tablet/desktop layout
- No framework, package manager or server dependency

## Vercel deployment

No build step is needed.

1. Upload this folder/repository to Vercel.
2. Framework preset: **Other** or static.
3. Build command: **empty**.
4. Output directory: project root (`.`).
5. Deploy.

## Streaming provider configuration

Open `app.js` and edit `STREAM_CONFIG` near the top:

```js
const STREAM_CONFIG = {
  providerName: "Your Stream Provider",
  enabled: true,
  buildEmbedUrl: ({ anilistId, malId, title, episode }) => {
    return `https://your-authorized-provider.example/embed/...`;
  },
};
```

The adapter is deliberately isolated. The project does not ship with a third-party stream endpoint.

## Local data

The browser stores:

- `nebula_watchlist_v2`
- `nebula_history_v2`
- `nebula_settings_v2`
- `nebula_search_history_v2`

No account or application backend is required.

## Suggested future integrations

For a full production service, connect an authorized streaming provider, a real authentication/account system, server-side caching for AniList, analytics, content reporting, CDN image optimization, and a legal content catalog.
