/* ==========================================================
   NEBULA — static anime streaming SPA
   Stack: HTML5 + Tailwind CDN + Vanilla JS
   Data: AniList GraphQL
   Persistence: localStorage
   ========================================================== */

const API_URL = "https://graphql.anilist.co";
const WATCHLIST_KEY = "nebula_watchlist_v2";
const HISTORY_KEY = "nebula_history_v2";
const SETTINGS_KEY = "nebula_settings_v2";
const SEARCH_HISTORY_KEY = "nebula_search_history_v2";

/* ==========================================================
   STREAM EMBED CONFIGURATION
   ----------------------------------------------------------
   Keep this section as the single integration point for a
   third-party/authorized streaming provider.

   Set enabled=true and make buildEmbedUrl return an iframe URL.
   The rest of the player does not need to change.
   ========================================================== */
const STREAM_CONFIG = {
    providerName: "Your Stream Provider",
    enabled: true,
    buildEmbedUrl: ({ anilistId, malId, title, episode }) => {
        return `https://mirurotvapi.vercel.app/api/embed/\({anilistId}/\){episode || 1}?lang=sub`;
    },
};

/* ------------------------------ GraphQL ------------------------------ */

const CARD_FRAGMENT = `
  fragment CardFields on Media {
    id
    idMal
    title { romaji english native }
    coverImage { large extraLarge }
    bannerImage
    averageScore
    popularity
    favourites
    episodes
    format
    status
    season
    seasonYear
    genres
  }
`;

const GQL = {
  home: `
    query Home($genre: String) {
      trending: Page(page: 1, perPage: 14) {
        media(sort: TRENDING_DESC, type: ANIME, isAdult: false) { ...CardFields }
      }
      popular: Page(page: 1, perPage: 14) {
        media(sort: POPULARITY_DESC, type: ANIME, isAdult: false) { ...CardFields }
      }
      topRated: Page(page: 1, perPage: 14) {
        media(sort: SCORE_DESC, type: ANIME, isAdult: false) { ...CardFields }
      }
      airing: Page(page: 1, perPage: 14) {
        media(sort: UPDATED_AT_DESC, status: RELEASING, type: ANIME, isAdult: false) { ...CardFields }
      }
      upcoming: Page(page: 1, perPage: 14) {
        media(sort: START_DATE_DESC, status: NOT_YET_RELEASED, type: ANIME, isAdult: false) { ...CardFields }
      }
      genre: Page(page: 1, perPage: 14) {
        media(sort: POPULARITY_DESC, type: ANIME, genre: $genre, isAdult: false) { ...CardFields }
      }
    }
    ${CARD_FRAGMENT}
  `,
  details: `
    query Details($id: Int!) {
      Media(id: $id, type: ANIME) {
        id
        idMal
        title { romaji english native }
        synonyms
        description(asHtml: false)
        coverImage { large extraLarge }
        bannerImage
        averageScore
        popularity
        favourites
        episodes
        duration
        format
        status
        season
        seasonYear
        genres
        tags { name rank }
        startDate { year month day }
        endDate { year month day }
        studios(isMain: true) { nodes { name } }
        relations {
          nodes {
            relationType
            node {
              id
              title { romaji english native }
              coverImage { large extraLarge }
              format
              seasonYear
            }
          }
        }
        recommendations(sort: RATING_DESC, perPage: 8) {
          nodes {
            rating
            mediaRecommendation { ...CardFields }
          }
        }
        characters(sort: ROLE, perPage: 6) {
          nodes {
            role
            name { full }
            image { large }
          }
        }
        nextAiringEpisode { airingAt timeUntilAiring episode }
        airingSchedule(notYetAired: false, perPage: 60) { nodes { episode airingAt } }
      }
    }
    ${CARD_FRAGMENT}
  `,
  search: `
    query Search($search: String!, $page: Int!, $genre: String, $sort: [MediaSort!]) {
      Page(page: $page, perPage: 24) {
        pageInfo { currentPage hasNextPage }
        media(search: $search, genre: $genre, type: ANIME, sort: $sort, isAdult: false) { ...CardFields }
      }
    }
    ${CARD_FRAGMENT}
  `,
  genre: `
    query GenreBrowse($genre: String!, $page: Int!, $sort: [MediaSort!]) {
      Page(page: $page, perPage: 24) {
        pageInfo { currentPage hasNextPage }
        media(genre: $genre, type: ANIME, sort: $sort, isAdult: false) { ...CardFields }
      }
    }
    ${CARD_FRAGMENT}
  `,
};

async function gql(query, variables = {}, retries = 1) {
  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      if (response.status === 429 && retries > 0) {
        await wait(900);
        return gql(query, variables, retries - 1);
      }
      throw new Error(`AniList API error: ${response.status}`);
    }
    const json = await response.json();
    if (json.errors?.length) throw new Error(json.errors[0].message || "AniList request failed");
    return json.data;
  } catch (error) {
    throw error;
  }
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const asArray = value => Array.isArray(value) ? value : [];


/* -------------------------------- State -------------------------------- */

const state = {
  route: "home",
  selectedGenre: "All",
  genres: [
    "All", "Action", "Adventure", "Comedy", "Drama", "Fantasy", "Horror",
    "Mystery", "Romance", "Sci-Fi", "Slice of Life", "Sports", "Supernatural", "Thriller"
  ],
  home: { trending: [], popular: [], topRated: [], airing: [], upcoming: [], genre: [] },
  homeGenreLoaded: null,
  heroIndex: 0,
  heroTimer: null,
  details: new Map(),
  detail: null,
  watchEpisode: 1,
  searchCache: new Map(),
  browseCache: new Map(),
  searchPage: 1,
  searchQuery: "",
  searchHasNext: false,
  searchGenre: "All",
  watchlistSort: "recent",
  watchlistFilter: "all",
  modal: null,
};

const app = document.querySelector("#app");
const searchOverlay = document.querySelector("#searchOverlay");
const searchInput = document.querySelector("#searchInput");
const searchResults = document.querySelector("#searchResults");
const toastEl = document.querySelector("#toast");

/* -------------------------------- Utilities -------------------------------- */

const escapeHTML = (value = "") => String(value).replace(/[&<>"']/g, char => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[char]));

const preferredTitle = media => media?.title?.english || media?.title?.romaji || media?.title?.native || "Untitled";
const cleanDescription = text => (text || "No description available.").replace(/\s+/g, " ").trim();
const formatScore = score => score ? `${Math.round(score)}%` : "—";
const yearOf = media => media?.seasonYear || media?.startDate?.year || "—";
const imgFor = media => media?.coverImage?.extraLarge || media?.coverImage?.large || "";
const bannerFor = media => media?.bannerImage || imgFor(media) || "";
const formatNumber = n => Number(n || 0).toLocaleString();
const titleSafe = media => escapeHTML(preferredTitle(media));
const debounce = (fn, ms = 300) => { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); }; };

function showToast(message) {
  toastEl.textContent = message;
  toastEl.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toastEl.classList.remove("show"), 2100);
}

function getRoute() {
  const parts = location.hash.replace(/^#/, "").split("/").filter(Boolean);
  if (!parts.length) return { name: "home" };
  if (parts[0] === "anime" && Number(parts[1])) return { name: "anime", id: Number(parts[1]) };
  if (parts[0] === "watch" && Number(parts[1])) return { name: "watch", id: Number(parts[1]), ep: Math.max(1, Number(parts[2]) || 1) };
  if (parts[0] === "watchlist") return { name: "watchlist" };
  if (parts[0] === "history") return { name: "history" };
  if (parts[0] === "browse") return { name: "browse", genre: decodeURIComponent(parts.slice(1).join("/")) || "Action" };
  return { name: "home" };
}

function routeTo(hash) {
  location.hash = hash.startsWith("#") ? hash : `#${hash}`;
}

function localGet(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}
function localSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

function getSettings() {
  return {
    autoplay: true,
    reduceMotion: false,
    blurUI: true,
    compactCards: false,
    ...localGet(SETTINGS_KEY, {}),
  };
}
function setSettings(next) { localSet(SETTINGS_KEY, { ...getSettings(), ...next }); }
function getWatchlist() { return asArray(localGet(WATCHLIST_KEY, [])); }
function setWatchlist(list) { localSet(WATCHLIST_KEY, list); }
function getHistory() { return asArray(localGet(HISTORY_KEY, [])); }
function setHistory(list) { localSet(HISTORY_KEY, list); }
function getSearchHistory() { return asArray(localGet(SEARCH_HISTORY_KEY, [])); }
function setSearchHistory(list) { localSet(SEARCH_HISTORY_KEY, list); }

function isInWatchlist(id) { return getWatchlist().some(item => item.id === id); }
function watchRecord(id) { return getHistory().find(item => item.id === id); }

function detailEpisodes(media) {
  const aired = Math.max(0, ...asArray(media?.airingSchedule?.nodes).map(n => Number(n.episode || 0)));
  const upcoming = media?.nextAiringEpisode?.episode ? Number(media.nextAiringEpisode.episode) - 1 : 0;
  return Math.max(Number(media?.episodes || 0), aired, upcoming, 1);
}

function rememberMedia(media) {
  if (!media?.id) return;
  const old = watchRecord(media.id);
  const item = {
    id: media.id,
    idMal: media.idMal || null,
    title: preferredTitle(media),
    cover: imgFor(media),
    banner: bannerFor(media),
    score: media.averageScore || null,
    year: media.seasonYear || null,
    episodes: media.episodes || null,
    lastEpisode: old?.lastEpisode || 1,
    completedEpisodes: old?.completedEpisodes || [],
    updatedAt: Date.now(),
  };
  const next = [item, ...asArray(getHistory()).filter(x => x.id !== media.id)].slice(0, 40);
  setHistory(next);
}

function updateEpisodeProgress(media, episode, watched = false) {
  const history = getHistory();
  const existing = history.find(item => item.id === media.id) || {
    id: media.id, title: preferredTitle(media), cover: imgFor(media), banner: bannerFor(media),
    score: media.averageScore || null, year: media.seasonYear || null, episodes: media.episodes || null,
    lastEpisode: episode, completedEpisodes: [], updatedAt: Date.now(),
  };
  existing.lastEpisode = episode;
  existing.updatedAt = Date.now();
  existing.completedEpisodes = Array.isArray(existing.completedEpisodes) ? existing.completedEpisodes : [];
  if (watched && !existing.completedEpisodes.includes(episode)) existing.completedEpisodes.push(episode);
  const sorted = [existing, ...asArray(history).filter(x => x.id !== media.id)].slice(0, 40);
  setHistory(sorted);
}

function isEpisodeWatched(id, episode) {
  return !!watchRecord(id)?.completedEpisodes?.includes(episode);
}

function toggleWatchlist(media) {
  const current = getWatchlist();
  const index = current.findIndex(item => item.id === media.id);
  if (index >= 0) {
    current.splice(index, 1);
    showToast("Removed from watchlist");
  } else {
    current.unshift({
      id: media.id,
      idMal: media.idMal || null,
      title: preferredTitle(media),
      cover: imgFor(media),
      banner: bannerFor(media),
      score: media.averageScore || null,
      year: media.seasonYear || null,
      episodes: media.episodes || null,
      addedAt: Date.now(),
    });
    showToast("Added to watchlist");
  }
  setWatchlist(current);
  renderCurrentRoute();
}

function buildLocalMedia(item) {
  return {
    id: item.id,
    idMal: item.idMal,
    title: { romaji: item.title },
    coverImage: { extraLarge: item.cover, large: item.cover },
    bannerImage: item.banner,
    averageScore: item.score,
    seasonYear: item.year,
    episodes: item.episodes,
    format: "ANIME",
  };
}

/* -------------------------------- UI primitives -------------------------------- */

function icon(name, size = 18) {
  const icons = {
    search: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
    play: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor"><path d="m8 5 11 7-11 7V5Z"/></svg>`,
    heart: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M20.8 8.7c0 5.5-8.8 10.4-8.8 10.4S3.2 14.2 3.2 8.7A4.7 4.7 0 0 1 8 4c1.5 0 2.9.7 4 1.8A5.1 5.1 0 0 1 16 4a4.7 4.7 0 0 1 4.8 4.7Z"/></svg>`,
    settings: `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/><path d="m19.4 15 .1.1a1.8 1.8 0 0 1-2.5 2.5l-.1-.1a1.8 1.8 0 0 0-3.1 1.2v.2a1.8 1.8 0 0 1-3.6 0v-.2a1.8 1.8 0 0 0-3.1-1.2l-.1.1a1.8 1.8 0 1 1-2.5-2.5l.1-.1A1.8 1.8 0 0 0 3.4 12v-.2a1.8 1.8 0 0 0-1.2-1.7l-.2-.1A1.8 1.8 0 0 1 3.8 6.7l.2.1A1.8 1.8 0 0 0 7.1 5.6v-.2a1.8 1.8 0 0 1 3.6 0v.2a1.8 1.8 0 0 0 3.1 1.2l.1-.1a1.8 1.8 0 1 1 2.5 2.5l-.1.1a1.8 1.8 0 0 0 1.2 3.1h.2a1.8 1.8 0 0 1 0 3.6h-.2a1.8 1.8 0 0 0-1.2 1.2Z"/></svg>`,
    check: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6"/></svg>`,
  };
  return icons[name] || "";
}

function navbar(active = "home") {
  return `
    <header class="glass-nav fixed inset-x-0 top-0 z-50">
      <div class="mx-auto flex h-[70px] max-w-[1600px] items-center gap-6 px-5 lg:px-8">
        <a href="#home" class="brand shrink-0 text-[20px] font-bold tracking-[-.05em]">NEBULA<span class="text-violet-400">.</span></a>
        <nav class="hidden items-center gap-5 text-sm md:flex">
          <a href="#home" class="nav-link ${active === "home" ? "active" : ""}">Home</a>
          <a href="#browse/Action" class="nav-link ${active === "browse" ? "active" : ""}">Discover</a>
          <a href="#watchlist" class="nav-link ${active === "watchlist" ? "active" : ""}">My Watchlist</a>
          <a href="#history" class="nav-link ${active === "history" ? "active" : ""}">History</a>
        </nav>
        <div class="ml-auto flex items-center gap-2">
          <button id="navSearch" class="btn-secondary flex h-10 items-center gap-2 px-3 text-sm" title="Search (/)">
            ${icon("search", 16)} <span class="hidden sm:inline text-white/60">Search</span><kbd class="kbd hidden lg:inline">/</kbd>
          </button>
          <button id="settingsButton" class="grid h-10 w-10 place-items-center rounded-xl border border-white/10 bg-white/[.04] text-white/55 transition hover:bg-white/[.08] hover:text-white" title="Settings">
            ${icon("settings", 17)}
          </button>
        </div>
      </div>
    </header>
  `;
}

function createAnimeCard(media) {
  const id = Number(media.id);
  const progress = watchRecord(id);
  const total = Number(media.episodes || progress?.episodes || 0);
  const last = Number(progress?.lastEpisode || 0);
  const percent = total && last ? Math.min(100, Math.round((last / total) * 100)) : 0;
  return `
    <article class="anime-card ${getSettings().compactCards ? "compact-card" : ""}" data-anime-id="${id}" tabindex="0" role="button" aria-label="${titleSafe(media)}">
      <div class="anime-poster">
        <img loading="lazy" src="${escapeHTML(imgFor(media))}" alt="${titleSafe(media)}" />
        ${percent ? `<div class="progress-track"><span style="width:${percent}%"></span></div>` : ""}
        <div class="card-overlay"><span class="play-chip">${icon("play", 17)}</span></div>
        <div class="card-badges">
          ${media.status === "RELEASING" ? `<span class="mini-badge live">AIRING</span>` : ""}
          ${media.averageScore ? `<span class="mini-badge">★ ${Math.round(media.averageScore)}</span>` : ""}
        </div>
      </div>
      <div class="card-title">${titleSafe(media)}</div>
      <div class="card-meta">${escapeHTML(media.format || "TV")} · ${yearOf(media)} · ${progress ? `EP ${last}` : formatScore(media.averageScore)}</div>
    </article>
  `;
}

function skeletonCards(count = 8) {
  return Array.from({ length: count }, () => `
    <div class="anime-card"><div class="anime-poster skeleton"></div><div class="mt-2 h-4 w-4/5 rounded skeleton"></div><div class="mt-2 h-3 w-1/2 rounded skeleton"></div></div>
  `).join("");
}
function skeletonRow(count = 8) { return `<div class="row-scroller">${skeletonCards(count)}</div>`; }

function section(title, subtitle, items, id = "") {
  items = asArray(items);
  if (!items.length) return "";
  return `
    <section class="mb-11" ${id ? `id="${id}"` : ""}>
      <div class="section-head px-1">
        <div><h2>${escapeHTML(title)}</h2><span>${escapeHTML(subtitle || "")}</span></div>
        <button class="section-more" data-see-section="${escapeHTML(id)}">Open</button>
      </div>
      <div class="row-scroller">${items.map(createAnimeCard).join("")}</div>
    </section>
  `;
}

function continueSection() {
  const list = asArray(getHistory()).slice().sort((a,b) => b.updatedAt - a.updatedAt).slice(0, 12);
  if (!list.length) return "";
  return section("Continue watching", "Pick up where you left off", list.map(buildLocalMedia), "continue");
}

function heroMarkup() {
  const items = asArray(state.home.trending);
  if (!items.length) return "";
  const m = items[state.heroIndex % Math.min(8, items.length)];
  return `
    <section class="hero">
      <div class="hero-bg" style="background-image:url('${escapeHTML(bannerFor(m))}')"></div>
      <div class="mx-auto flex min-h-[640px] max-w-[1600px] items-end px-5 pb-24 lg:px-8">
        <div class="hero-copy max-w-3xl">
          <div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-white/55">
            <span class="rounded-full border border-white/10 bg-white/[.06] px-2.5 py-1">TRENDING #${state.heroIndex + 1}</span>
            <span>${escapeHTML(m.format || "ANIME")}</span><span>•</span><span>${yearOf(m)}</span><span>•</span><span>★ ${formatScore(m.averageScore)}</span>
          </div>
          <h1 class="hero-title font-semibold">${titleSafe(m)}</h1>
          <p class="mt-5 max-w-2xl text-sm leading-6 text-white/53 md:text-[15px]">Discover ${titleSafe(m)} with a cinematic interface, instant metadata and persistent personal progress.</p>
          <div class="mt-7 flex flex-wrap gap-3">
            <a class="btn-primary inline-flex h-12 items-center gap-2 px-5" href="#anime/${m.id}">${icon("play", 17)} Explore anime</a>
            <button class="btn-secondary h-12 px-5" data-watch-toggle="${m.id}">${isInWatchlist(m.id) ? `${icon("check")} In watchlist` : "+ Add to watchlist"}</button>
          </div>
        </div>
      </div>
      <div class="absolute inset-x-0 bottom-8 z-10"><div class="mx-auto flex max-w-[1600px] items-center justify-between gap-6 px-5 lg:px-8">
        <div class="hero-dots flex items-center gap-2">${asArray(items).slice(0,8).map((_, i) => `<button class="${i === state.heroIndex ? "active" : ""}" data-hero-index="${i}" aria-label="Spotlight ${i+1}"></button>`).join("")}</div>
        <div class="hidden text-xs text-white/35 sm:block">← / → spotlight · P pause</div>
      </div></div>
    </section>
  `;
}

function genrePills() {
  return `<div class="flex gap-2 overflow-x-auto pb-1 scrollbar-none">${state.genres.map(g => `<button class="pill ${state.selectedGenre === g ? "active" : ""}" data-genre="${escapeHTML(g)}">${escapeHTML(g)}</button>`).join("")}</div>`;
}

/* -------------------------------- Home -------------------------------- */

async function loadHome() {
  const genre = state.selectedGenre === "All" ? null : state.selectedGenre;
  const data = await gql(GQL.home, { genre });
  const safePage = key => asArray(data?.[key]?.media);
  state.home = {
    trending: safePage("trending"),
    popular: safePage("popular"),
    topRated: safePage("topRated"),
    airing: safePage("airing"),
    upcoming: safePage("upcoming"),
    genre: safePage("genre"),
  };
  state.homeGenreLoaded = state.selectedGenre;
}

async function renderHome() {
  state.route = "home";
  app.innerHTML = `
    <div class="gradient-orb orb-a"></div><div class="gradient-orb orb-b"></div>
    ${navbar("home")}
    <main class="pb-16 pt-[70px]">
      ${heroMarkup()}
      <div class="mx-auto max-w-[1600px] px-5 lg:px-8">
        ${continueSection()}
        <section class="mb-9 mt-3"><div class="section-head"><div><h2>Browse by genre</h2><span>Filter the catalog without leaving the page</span></div></div>${genrePills()}</section>
        ${section("Trending now", "What the community is watching", state.home.trending, "trending")}
        ${section("Currently airing", "Series with active release schedules", state.home.airing, "airing")}
        ${section("Popular", "Fan favorites across the catalog", state.home.popular, "popular")}
        ${section("Top rated", "Highest-rated anime on AniList", state.home.topRated, "toprated")}
        ${section("Upcoming", "New series on the horizon", state.home.upcoming, "upcoming")}
        ${section(`${state.selectedGenre} picks`, `Popular ${state.selectedGenre.toLowerCase()} anime`, state.home.genre, "genre")}
        ${showcaseSection()}
        ${quickFooter()}
      </div>
    </main>
  `;
  bindCommon();
  injectMainAnimeGrid();
  startHeroTimer();
}

function showcasePool() {
  const combined = [
    ...asArray(state.home.trending),
    ...asArray(state.home.popular),
    ...asArray(state.home.topRated),
    ...asArray(state.home.airing),
    ...asArray(state.home.upcoming),
    ...asArray(state.home.genre),
  ];
  const seen = new Set();
  return combined.filter(media => {
    const id = Number(media?.id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).slice(0, 28);
}

function injectMainAnimeGrid(items = showcasePool()) {
  const grid = document.querySelector('#mainAnimeGrid');
  if (!grid) return;

  // This is the direct UI injection point requested for AniList data.
  // Every returned Media object becomes a real interactive anime card.
  if (!Array.isArray(items) || !items.length) {
    grid.innerHTML = `<div class="empty-state col-span-full"><h3 class="text-lg font-semibold">No anime available right now</h3><p class="mt-2 text-sm text-white/40">AniList returned no titles for this section.</p></div>`;
    return;
  }

  grid.innerHTML = items.map(media => createAnimeCard(media)).join('');
  bindCards();
}

function showcaseSection() {
  return `
    <section id="showcase" class="mb-11">
      <div class="section-head px-1">
        <div><h2>Anime showcase</h2><span>One big catalog view — trending, popular, airing and top-rated titles</span></div>
        <span class="hidden sm:block">Live from AniList</span>
      </div>
      <div id="mainAnimeGrid" class="grid grid-cols-2 gap-x-3 gap-y-8 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8"></div>
    </section>
  `;
}

function quickFooter() {
  return `
    <section class="glass-panel rounded-2xl p-5 md:p-7">
      <div class="flex flex-col justify-between gap-5 md:flex-row md:items-center">
        <div><div class="text-xs uppercase tracking-[.15em] text-white/30">NEBULA</div><h2 class="mt-1 text-xl font-semibold">Your personal anime dashboard.</h2><p class="mt-2 max-w-xl text-sm leading-6 text-white/38">Everything here stays local to this browser: watchlist, history, settings, searches and episode completion.</p></div>
        <div class="flex flex-wrap gap-2"><a href="#watchlist" class="pill">Watchlist</a><a href="#history" class="pill">History</a><a href="#browse/Action" class="pill">Discover more</a></div>
      </div>
    </section>
  `;
}

function startHeroTimer() {
  clearInterval(state.heroTimer);
  if (!getSettings().autoplay) return;
  state.heroTimer = setInterval(() => {
    if (!document.hidden && state.route === "home" && asArray(state.home.trending).length) {
      state.heroIndex = (state.heroIndex + 1) % Math.min(8, asArray(state.home.trending).length);
      const y = window.scrollY;
      renderHome();
      window.scrollTo(0, y);
    }
  }, 6500);
}

async function bootHome() {
  clearInterval(state.heroTimer);
  const needsReload = !asArray(state.home.trending).length || state.homeGenreLoaded !== state.selectedGenre;
  if (needsReload) {
    app.innerHTML = `${navbar("home")}<main class="min-h-screen pt-[70px]"><div class="mx-auto max-w-[1600px] px-5 py-12 lg:px-8"><div class="h-[500px] rounded-[24px] skeleton"></div><div class="mt-12">${skeletonRow(10)}</div></div></main>`;
    try { await loadHome(); } catch (e) { return renderError("Could not load AniList", e.message); }
  }
  await renderHome();
}

/* -------------------------------- Details -------------------------------- */

function detailsMeta(m) {
  const next = m.nextAiringEpisode ? `Next EP ${m.nextAiringEpisode.episode} in ${Math.max(0, Math.ceil(m.nextAiringEpisode.timeUntilAiring / 86400))}d` : "";
  return [m.format, yearOf(m), m.duration ? `${m.duration} min` : "", m.status?.replaceAll("_", " "), next].filter(Boolean).join(" • ");
}

function episodeGrid(m, limit = Infinity) {
  const total = Math.min(detailEpisodes(m), limit);
  return Array.from({ length: total }, (_, i) => i + 1).map(ep => `
    <a href="#watch/${m.id}/${ep}" class="episode-btn ${isEpisodeWatched(m.id, ep) ? "watched" : ""}">
      <span>EP ${ep}</span>${isEpisodeWatched(m.id, ep) ? icon("check", 14) : ""}
    </a>
  `).join("");
}

function relationCards(m) {
  const list = asArray(m?.relations?.nodes).filter(x => x?.node?.type !== "MANGA").slice(0, 8);
  if (!list.length) return "";
  return `
    <section class="mb-10"><div class="section-head"><div><h2>Related anime</h2><span>Sequels, prequels and connected entries</span></div></div>
      <div class="row-scroller">${list.map(r => `<div class="relation-card" data-anime-id="${r.node.id}" tabindex="0"><img src="${escapeHTML(imgFor(r.node))}" alt="${titleSafe(r.node)}"><div class="mt-2 text-[13px] font-semibold">${titleSafe(r.node)}</div><div class="mt-1 text-[10px] uppercase text-white/35">${escapeHTML(r.relationType?.replaceAll("_", " ") || "RELATED")}</div></div>`).join("")}</div>
    </section>
  `;
}

function characterStrip(m) {
  const chars = asArray(m?.characters?.nodes);
  if (!chars.length) return "";
  return `
    <section class="mb-10"><div class="section-head"><div><h2>Characters</h2><span>Key cast</span></div></div>
      <div class="character-row">${chars.map(c => `<div class="character-card"><img src="${escapeHTML(c.image?.large || "")}" alt="${escapeHTML(c.name?.full || "")}"><div class="mt-2 truncate text-xs font-semibold">${escapeHTML(c.name?.full || "Unknown")}</div><div class="mt-1 text-[10px] text-white/35">${escapeHTML(c.role || "")}</div></div>`).join("")}</div>
    </section>
  `;
}

async function renderDetails(id) {
  state.route = "anime";
  app.innerHTML = `${navbar()}<main class="pt-[70px]"><div class="mx-auto max-w-[1600px] px-5 py-12 lg:px-8">${skeletonRow(8)}</div></main>`;
  try {
    let m = state.details.get(id);
    if (!m) {
      const data = await gql(GQL.details, { id });
      m = data.Media;
      state.details.set(id, m);
    }
    state.detail = m;
    rememberMedia(m);
    const recs = asArray(m?.recommendations?.nodes).map(n => n?.mediaRecommendation).filter(Boolean);
    app.innerHTML = `
      ${navbar()}
      <main class="pt-[70px]">
        <section class="details-backdrop" style="background-image:url('${escapeHTML(bannerFor(m))}')">
          <div class="detail-body mx-auto max-w-[1600px] px-5 lg:px-8">
            <div class="flex flex-col gap-7 md:flex-row md:items-end">
              <div class="detail-poster hidden shrink-0 sm:block"><img src="${escapeHTML(imgFor(m))}" alt="${titleSafe(m)}"></div>
              <div class="max-w-4xl">
                <div class="flex flex-wrap items-center gap-2 text-[11px] uppercase tracking-[.12em] text-white/45">${escapeHTML(detailsMeta(m))}</div>
                <h1 class="mt-4 text-4xl font-semibold tracking-[-.05em] sm:text-6xl">${titleSafe(m)}</h1>
                <p class="mt-5 max-w-3xl text-sm leading-7 text-white/55">${escapeHTML(cleanDescription(m.description))}</p>
                <div class="mt-5 flex flex-wrap gap-2">${asArray(m?.genres).slice(0, 8).map(g => `<button class="pill" data-genre="${escapeHTML(g)}">${escapeHTML(g)}</button>`).join("")}</div>
                <div class="mt-7 flex flex-wrap gap-3">
                  <a href="#watch/${m.id}/${watchRecord(m.id)?.lastEpisode || 1}" class="btn-primary inline-flex h-12 items-center gap-2 px-5">${icon("play", 17)} ${watchRecord(m.id) ? `Resume EP ${watchRecord(m.id).lastEpisode}` : "Watch episode 1"}</a>
                  <button class="btn-secondary h-12 px-5" data-detail-watchlist>${isInWatchlist(m.id) ? `${icon("check")} In watchlist` : "+ Add to watchlist"}</button>
                </div>
                <div class="mt-8 flex flex-wrap gap-6 text-xs text-white/38">
                  <span>Score <b class="text-white">${formatScore(m.averageScore)}</b></span><span>Popularity <b class="text-white">${formatNumber(m.popularity)}</b></span><span>Favorites <b class="text-white">${formatNumber(m.favourites)}</b></span><span>Studio <b class="text-white">${escapeHTML(m.studios?.nodes?.[0]?.name || "—")}</b></span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="mx-auto max-w-[1600px] px-5 py-12 lg:px-8">
          <div class="section-head"><div><h2>Episodes</h2><span>${detailEpisodes(m)} episode slots · green check marks watched episodes</span></div><div class="flex gap-2"><button class="pill" data-mark-all>Mark available as watched</button></div></div>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-9">${episodeGrid(m, 120)}</div>
          ${detailEpisodes(m) > 120 ? `<p class="mt-4 text-xs text-white/30">Showing first 120 episodes. Use the streaming provider or API data to navigate beyond this list.</p>` : ""}
        </section>

        <section class="mx-auto max-w-[1600px] px-5 pb-3 lg:px-8"><div class="grid gap-6 lg:grid-cols-[1.25fr_.75fr]">
          <div class="glass-panel rounded-2xl p-6"><h2 class="font-semibold">Information</h2><div class="mt-5 grid grid-cols-2 gap-4 text-xs sm:grid-cols-3">
            <div><div class="text-white/30">Status</div><div class="mt-1 text-white/80">${escapeHTML(m.status || "—")}</div></div>
            <div><div class="text-white/30">Format</div><div class="mt-1 text-white/80">${escapeHTML(m.format || "—")}</div></div>
            <div><div class="text-white/30">Episodes</div><div class="mt-1 text-white/80">${m.episodes || "—"}</div></div>
            <div><div class="text-white/30">Season</div><div class="mt-1 text-white/80">${escapeHTML([m.season, m.seasonYear].filter(Boolean).join(" ") || "—")}</div></div>
            <div><div class="text-white/30">Premiered</div><div class="mt-1 text-white/80">${escapeHTML([m.startDate?.year, m.startDate?.month, m.startDate?.day].filter(Boolean).join("-") || "—")}</div></div>
            <div><div class="text-white/30">MAL ID</div><div class="mt-1 text-white/80">${m.idMal || "—"}</div></div>
          </div></div>
          <div class="glass-panel rounded-2xl p-6"><h2 class="font-semibold">Tags</h2><div class="mt-4 flex flex-wrap gap-2">${asArray(m?.tags).slice(0, 20).map(t => `<span class="pill">${escapeHTML(t.name)}</span>`).join("") || `<span class="text-sm text-white/35">No tags available.</span>`}</div></div>
        </div></section>

        <div class="mx-auto max-w-[1600px] px-5 pt-10 lg:px-8">${characterStrip(m)}${relationCards(m)}${recs.length ? section("You may also like", "Recommendations from AniList", recs, "recommendations") : ""}</div>
      </main>
    `;
    bindCommon();
    document.querySelector("[data-detail-watchlist]")?.addEventListener("click", () => toggleWatchlist(m));
    document.querySelector("[data-mark-all]")?.addEventListener("click", () => {
      const history = getHistory();
      let existing = history.find(x => x.id === m.id);
      if (!existing) {
        rememberMedia(m);
        existing = watchRecord(m.id);
      }
      existing.completedEpisodes = Array.from({ length: detailEpisodes(m) }, (_, i) => i + 1);
      existing.lastEpisode = detailEpisodes(m);
      existing.updatedAt = Date.now();
      setHistory([existing, ...asArray(getHistory()).filter(x => x.id !== m.id)].slice(0, 40));
      showToast("Marked available episodes as watched");
      renderDetails(id);
    });
  } catch (e) {
    renderError("Unable to load this anime", e.message);
  }
}

/* -------------------------------- Player -------------------------------- */

function playerUnavailable(m, episode) {
  return `<div class="player-placeholder"><div class="relative z-10 max-w-lg px-6 text-center"><div class="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-white/10 bg-white/[.05]">${icon("play", 22)}</div><h2 class="text-lg font-semibold">Player endpoint not configured</h2><p class="mt-2 text-sm leading-6 text-white/42">Connect your authorized provider in <code>STREAM_CONFIG</code> near the top of <code>app.js</code>. The metadata, history and episode UI are already wired.</p><div class="mt-5 rounded-xl border border-white/8 bg-black/20 p-4 text-left text-[11px] leading-6 text-white/35">Provider: <span class="text-white/65">${escapeHTML(STREAM_CONFIG.providerName)}</span><br>AniList ID: <span class="text-white/65">${m.id}</span><br>MAL ID: <span class="text-white/65">${m.idMal || "n/a"}</span><br>Episode: <span class="text-white/65">${episode}</span></div></div></div>`;
}

async function renderPlayer(id, episode) {
  state.route = "watch";
  app.innerHTML = `${navbar()}<main class="pt-[70px]"><div class="mx-auto max-w-[1600px] px-5 py-12 lg:px-8">${skeletonRow(7)}</div></main>`;
  try {
    let m = state.details.get(id);
    if (!m) { const data = await gql(GQL.details, { id }); m = data.Media; state.details.set(id, m); }
    state.detail = m;
    state.watchEpisode = episode;
    rememberMedia(m);
    updateEpisodeProgress(m, episode, false);
    const title = preferredTitle(m);
    const embedUrl = STREAM_CONFIG.enabled ? STREAM_CONFIG.buildEmbedUrl({ anilistId: m.id, malId: m.idMal, title, episode }) : "";
    const total = detailEpisodes(m);
    const prev = episode > 1 ? episode - 1 : null;
    const next = episode < total ? episode + 1 : null;

    app.innerHTML = `
      ${navbar()}
      <main class="pt-[70px] pb-16">
        <div class="mx-auto max-w-[1600px] px-5 py-8 lg:px-8">
          <div class="mb-5 flex flex-wrap items-center justify-between gap-4"><div><a href="#anime/${m.id}" class="text-xs text-white/35 transition hover:text-white">← Back to anime</a><h1 class="mt-2 text-2xl font-semibold tracking-[-.03em]">${titleSafe(m)}</h1><p class="mt-1 text-xs text-white/35">Episode ${episode} ${isEpisodeWatched(m.id, episode) ? "· watched" : "· in progress"}</p></div><div class="flex gap-2">${prev ? `<a href="#watch/${m.id}/${prev}" class="pill">← EP ${prev}</a>` : ""}${next ? `<a href="#watch/${m.id}/${next}" class="pill">EP ${next} →</a>` : ""}</div></div>
          <div class="player-wrap">${embedUrl ? `<iframe class="video-frame" src="${escapeHTML(embedUrl)}" allow="autoplay; fullscreen; picture-in-picture; encrypted-media" allowfullscreen referrerpolicy="origin" title="${titleSafe(m)} episode ${episode}"></iframe>` : playerUnavailable(m, episode)}</div>
          <div class="player-toolbar glass-panel mt-3 flex flex-wrap items-center gap-2 rounded-2xl p-3">
            <button class="pill active" data-mark-episode>${isEpisodeWatched(m.id, episode) ? "✓ Watched" : "Mark watched"}</button>
            <button class="pill" data-prev-episode ${prev ? "" : "disabled"}>Previous</button>
            <button class="pill" data-next-episode ${next ? "" : "disabled"}>Next</button>
            <button class="pill ml-auto" data-player-watchlist>${isInWatchlist(m.id) ? "♥ In watchlist" : "♡ Add to watchlist"}</button>
          </div>

          <div class="mt-7 grid gap-6 lg:grid-cols-[1fr_300px]">
            <section class="glass-panel rounded-2xl p-5"><div class="flex items-center justify-between gap-4"><div><h2 class="font-semibold">Episode library</h2><p class="mt-1 text-xs text-white/35">Watched episodes stay saved locally.</p></div><a href="#anime/${m.id}" class="pill">Details</a></div><div class="mt-5 grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">${episodeGrid(m)}</div></section>
            <aside class="glass-panel rounded-2xl p-5"><div class="flex gap-3"><img class="h-24 w-16 rounded-lg object-cover" src="${escapeHTML(imgFor(m))}" alt="${titleSafe(m)}"><div><div class="text-sm font-semibold">${titleSafe(m)}</div><div class="mt-1 text-xs text-white/35">${escapeHTML(m.format || "ANIME")} · ${yearOf(m)}</div><div class="mt-4 text-xs text-white/50">Score <span class="text-white">${formatScore(m.averageScore)}</span></div></div></div><div class="mt-5 rounded-xl bg-white/[.035] p-3 text-xs text-white/45">Current episode <b class="text-white">${episode}</b> of <b class="text-white">${total}</b></div></aside>
          </div>
        </div>
      </main>
    `;
    bindCommon();
    document.querySelector("[data-mark-episode]")?.addEventListener("click", () => {
      updateEpisodeProgress(m, episode, !isEpisodeWatched(m.id, episode));
      showToast(isEpisodeWatched(m.id, episode) ? "Episode marked watched" : "Episode marked unwatched");
      renderPlayer(id, episode);
    });
    document.querySelector("[data-prev-episode]")?.addEventListener("click", () => prev && routeTo(`#watch/${m.id}/${prev}`));
    document.querySelector("[data-next-episode]")?.addEventListener("click", () => next && routeTo(`#watch/${m.id}/${next}`));
    document.querySelector("[data-player-watchlist]")?.addEventListener("click", () => toggleWatchlist(m));
  } catch (e) {
    renderError("Unable to load the player", e.message);
  }
}

/* -------------------------------- Watchlist / History -------------------------------- */

function watchlistItems() {
  let list = asArray(getWatchlist()).slice();
  if (state.watchlistFilter === "airing") list = list.filter(x => x.airing);
  if (state.watchlistFilter === "unfinished") list = list.filter(x => !watchRecord(x.id)?.completedEpisodes?.length || (x.episodes && (watchRecord(x.id)?.lastEpisode || 0) < x.episodes));
  if (state.watchlistSort === "alpha") list.sort((a,b) => a.title.localeCompare(b.title));
  if (state.watchlistSort === "score") list.sort((a,b) => Number(b.score || 0) - Number(a.score || 0));
  if (state.watchlistSort === "recent") list.sort((a,b) => Number(b.addedAt || 0) - Number(a.addedAt || 0));
  return list;
}

function renderWatchlist() {
  state.route = "watchlist";
  const list = watchlistItems();
  const cards = list.length ? `<div class="grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8">${list.map(x => createAnimeCard(buildLocalMedia(x))).join("")}</div>` : `<div class="empty-state"><div class="text-4xl">♡</div><h2 class="mt-3 text-lg font-semibold">Nothing here yet</h2><p class="mx-auto mt-2 max-w-md text-sm leading-6 text-white/38">Save anime from any card or details page and your personal library will appear here.</p><a href="#home" class="btn-primary mt-5 inline-flex h-11 items-center px-5 text-sm">Discover anime</a></div>`;
  app.innerHTML = `
    ${navbar("watchlist")}
    <main class="min-h-screen pt-[70px]"><div class="mx-auto max-w-[1600px] px-5 py-12 lg:px-8">
      <div class="mb-8 flex flex-col justify-between gap-5 lg:flex-row lg:items-end"><div><span class="text-xs uppercase tracking-[.15em] text-white/30">Library</span><h1 class="mt-2 text-4xl font-semibold tracking-[-.05em]">My Watchlist</h1><p class="mt-2 text-sm text-white/40">${list.length} saved title${list.length === 1 ? "" : "s"}</p></div><div class="flex flex-wrap gap-2"><button class="pill ${state.watchlistFilter === "all" ? "active" : ""}" data-wfilter="all">All</button><button class="pill ${state.watchlistFilter === "unfinished" ? "active" : ""}" data-wfilter="unfinished">Unfinished</button><select id="watchSort" class="pill cursor-pointer bg-[#121219] outline-none"><option value="recent" ${state.watchlistSort === "recent" ? "selected" : ""}>Recently added</option><option value="alpha" ${state.watchlistSort === "alpha" ? "selected" : ""}>A–Z</option><option value="score" ${state.watchlistSort === "score" ? "selected" : ""}>Highest score</option></select></div></div>
      ${cards}
    </div></main>
  `;
  bindCommon();
  document.querySelectorAll("[data-wfilter]").forEach(b => b.addEventListener("click", () => { state.watchlistFilter = b.dataset.wfilter; renderWatchlist(); }));
  document.querySelector("#watchSort")?.addEventListener("change", e => { state.watchlistSort = e.target.value; renderWatchlist(); });
}

function renderHistory() {
  state.route = "history";
  const list = asArray(getHistory()).slice().sort((a,b) => b.updatedAt - a.updatedAt);
  const cards = list.length ? `<div class="grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8">${list.map(x => createAnimeCard(buildLocalMedia(x))).join("")}</div>` : `<div class="empty-state"><div class="text-4xl">◷</div><h2 class="mt-3 text-lg font-semibold">No viewing history</h2><p class="mx-auto mt-2 max-w-md text-sm leading-6 text-white/38">Open an anime and start an episode. Your last position is kept locally.</p></div>`;
  app.innerHTML = `${navbar("history")}<main class="min-h-screen pt-[70px]"><div class="mx-auto max-w-[1600px] px-5 py-12 lg:px-8"><div class="mb-8 flex items-end justify-between gap-4"><div><span class="text-xs uppercase tracking-[.15em] text-white/30">Activity</span><h1 class="mt-2 text-4xl font-semibold tracking-[-.05em]">History</h1><p class="mt-2 text-sm text-white/40">Your recently opened anime and last episodes.</p></div>${list.length ? `<button class="pill" data-clear-history>Clear history</button>` : ""}</div>${cards}</div></main>`;
  bindCommon();
  document.querySelector("[data-clear-history]")?.addEventListener("click", () => { setHistory([]); showToast("History cleared"); renderHistory(); });
}

/* -------------------------------- Browse -------------------------------- */

async function renderBrowse(genre) {
  state.route = "browse";
  state.selectedGenre = genre;
  app.innerHTML = `${navbar("browse")}<main class="pt-[70px]"><div class="mx-auto max-w-[1600px] px-5 py-12 lg:px-8"><div class="h-24 rounded-2xl skeleton"></div><div class="mt-10">${skeletonRow(10)}</div></div></main>`;
  try {
    const cacheKey = `${genre}|POPULARITY_DESC`;
    let payload = state.browseCache.get(cacheKey);
    if (!payload) {
      payload = await gql(GQL.genre, { genre, page: 1, sort: ["POPULARITY_DESC"] });
      state.browseCache.set(cacheKey, payload);
    }
    const items = asArray(payload?.Page?.media);
    app.innerHTML = `${navbar("browse")}<main class="pt-[70px]"><div class="mx-auto max-w-[1600px] px-5 py-12 lg:px-8"><div class="flex flex-col justify-between gap-5 lg:flex-row lg:items-end"><div><span class="text-xs uppercase tracking-[.15em] text-white/30">Discover</span><h1 class="mt-2 text-4xl font-semibold tracking-[-.05em]">${escapeHTML(genre)}</h1><p class="mt-2 text-sm text-white/40">24 popular titles in this genre.</p></div><div class="flex flex-wrap gap-2">${genrePills()}</div></div><div class="mt-10 grid grid-cols-2 gap-x-3 gap-y-7 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-7 xl:grid-cols-8">${items.map(createAnimeCard).join("")}</div></div></main>`;
    bindCommon();
  } catch (e) { renderError("Unable to load this genre", e.message); }
}

/* -------------------------------- Search -------------------------------- */

function openSearch() {
  searchOverlay.classList.remove("hidden");
  searchOverlay.setAttribute("aria-hidden", "false");
  document.body.classList.add("overflow-hidden");
  renderSearchStart();
  setTimeout(() => searchInput.focus(), 25);
}
function closeSearch() {
  searchOverlay.classList.add("hidden");
  searchOverlay.setAttribute("aria-hidden", "true");
  document.body.classList.remove("overflow-hidden");
}
function renderSearchStart() {
  const recent = asArray(getSearchHistory()).slice(0, 8);
  searchResults.innerHTML = recent.length ? `<div class="mb-3 px-2 text-[10px] uppercase tracking-[.15em] text-white/25">Recent searches</div>${recent.map(q => `<button class="recent-search" data-recent-search="${escapeHTML(q)}">${icon("search", 14)}<span>${escapeHTML(q)}</span></button>`).join("")}` : `<div class="grid place-items-center py-14 text-center"><div class="text-4xl">⌕</div><div class="mt-3 text-sm text-white/45">Search anime, characters, titles or franchises.</div><div class="mt-2 text-xs text-white/25">Results update as you type.</div></div>`;
}
function addSearchHistory(q) {
  if (!q) return;
  const list = [q, ...asArray(getSearchHistory()).filter(item => item.toLowerCase() !== q.toLowerCase())].slice(0, 12);
  setSearchHistory(list);
}
function searchMarkup(items) {
  items = asArray(items);
  if (!items.length) return `<div class="py-14 text-center text-sm text-white/35">No anime found for this query.</div>`;
  return `<div class="grid gap-1">${items.map(m => `<div class="search-result" data-search-id="${m.id}" tabindex="0"><img src="${escapeHTML(imgFor(m))}" alt=""><div class="min-w-0"><div class="search-result-title truncate">${titleSafe(m)}</div><div class="search-result-meta">${escapeHTML(m.format || "ANIME")} · ${yearOf(m)} · ${formatScore(m.averageScore)}</div></div><span class="text-xs text-white/25">↵</span></div>`).join("")}</div>`;
}
function skeletonSearch() { return Array.from({ length: 7 }, () => `<div class="search-result"><div class="h-[60px] w-[45px] rounded-lg skeleton"></div><div><div class="h-4 w-2/3 rounded skeleton"></div><div class="mt-2 h-3 w-1/3 rounded skeleton"></div></div></div>`).join(""); }

async function doSearch(query, append = false) {
  const q = query.trim();
  if (!q) return renderSearchStart();
  state.searchQuery = q;
  if (!append) {
    state.searchPage = 1;
    searchResults.innerHTML = skeletonSearch();
  } else {
    const loadMore = document.querySelector("#searchLoadMore");
    if (loadMore) loadMore.textContent = "Loading…";
  }
  try {
    const data = await gql(GQL.search, { search: q, page: state.searchPage, genre: state.searchGenre === "All" ? null : state.searchGenre, sort: ["SEARCH_MATCH"] });
    const results = asArray(data?.Page?.media);
    state.searchHasNext = !!data?.Page?.pageInfo?.hasNextPage;
    const old = append ? (state.searchCache.get(q) || []) : [];
    const combined = [...old, ...results];
    state.searchCache.set(q, combined);
    searchResults.innerHTML = `${searchMarkup(combined)}${state.searchHasNext ? `<button id="searchLoadMore" class="btn-secondary mt-3 h-11 w-full text-sm">Load more results</button>` : ""}`;
    bindSearchResults();
    addSearchHistory(q);
  } catch (e) {
    searchResults.innerHTML = `<div class="py-14 text-center text-sm text-red-300/70">Search failed. Try again in a moment.</div>`;
  }
}

function bindSearchResults() {
  searchResults.querySelectorAll("[data-search-id]").forEach(row => {
    const go = () => { closeSearch(); routeTo(`#anime/${row.dataset.searchId}`); };
    row.addEventListener("click", go);
    row.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
  });
  document.querySelector("#searchLoadMore")?.addEventListener("click", () => { state.searchPage += 1; doSearch(state.searchQuery, true); });
}
const debouncedSearch = debounce(() => doSearch(searchInput.value), 280);

/* -------------------------------- Settings / Command -------------------------------- */

function openSettings() {
  const s = getSettings();
  state.modal = "settings";
  document.body.classList.add("overflow-hidden");
  const modal = document.createElement("div");
  modal.id = "settingsModal";
  modal.className = "overlay";
  modal.innerHTML = `<div class="overlay-backdrop" data-close-settings></div><section class="settings-modal glass-panel" role="dialog" aria-modal="true"><div class="flex items-center justify-between border-b border-white/10 px-5 py-4"><div><div class="text-xs uppercase tracking-[.15em] text-white/25">Preferences</div><h2 class="mt-1 text-lg font-semibold">NEBULA Settings</h2></div><button class="pill" data-close-settings>Esc</button></div><div class="space-y-1 p-4">
    ${settingRow("Autoplay hero spotlight", "Cycle the home spotlight automatically.", "autoplay", s.autoplay)}
    ${settingRow("Reduce motion", "Disable most interface motion and transitions.", "reduceMotion", s.reduceMotion)}
    ${settingRow("Glass blur", "Use stronger backdrop blur on glass surfaces.", "blurUI", s.blurUI)}
    ${settingRow("Compact cards", "Fit more anime into horizontal rows.", "compactCards", s.compactCards)}
  </div><div class="border-t border-white/10 p-4"><div class="text-xs text-white/35">Storage</div><div class="mt-3 grid gap-2 sm:grid-cols-2"><button class="pill" data-clear-searches>Clear search history</button><button class="pill" data-clear-library>Clear watchlist + history</button></div></div></section>`;
  document.body.appendChild(modal);
  modal.querySelectorAll("[data-setting]").forEach(el => el.addEventListener("click", () => {
    const key = el.dataset.setting;
    const nextValue = !getSettings()[key];
    setSettings({ [key]: nextValue });
    document.documentElement.classList.toggle("reduce-motion", !!getSettings().reduceMotion);
    document.documentElement.classList.toggle("no-blur", !getSettings().blurUI);
    document.documentElement.classList.toggle("compact-mode", !!getSettings().compactCards);
    showToast(`${key} ${nextValue ? "on" : "off"}`);
    modal.remove();
    document.body.classList.remove("overflow-hidden");
    renderCurrentRoute();
  }));
  modal.querySelectorAll("[data-close-settings]").forEach(el => el.addEventListener("click", closeSettings));
  modal.querySelector("[data-clear-searches]")?.addEventListener("click", () => { setSearchHistory([]); showToast("Search history cleared"); });
  modal.querySelector("[data-clear-library]")?.addEventListener("click", () => { setWatchlist([]); setHistory([]); showToast("Local library cleared"); renderCurrentRoute(); closeSettings(); });
}
function settingRow(label, text, key, enabled) {
  return `<button class="setting-row" data-setting="${key}"><div><div class="text-sm font-semibold">${escapeHTML(label)}</div><div class="mt-1 text-xs text-white/35">${escapeHTML(text)}</div></div><span class="switch ${enabled ? "on" : ""}"><i></i></span></button>`;
}
function closeSettings() {
  document.querySelector("#settingsModal")?.remove();
  document.body.classList.remove("overflow-hidden");
  state.modal = null;
}

/* -------------------------------- Bindings -------------------------------- */

function bindCards() {
  document.querySelectorAll("[data-anime-id]").forEach(card => {
    const go = () => routeTo(`#anime/${card.dataset.animeId}`);
    card.addEventListener("click", go);
    card.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}

function bindCommon() {
  document.querySelector("#navSearch")?.addEventListener("click", openSearch);
  document.querySelector("#settingsButton")?.addEventListener("click", openSettings);
  bindCards();
  document.querySelectorAll("[data-watch-toggle]").forEach(btn => btn.addEventListener("click", e => {
    e.stopPropagation();
    const id = Number(btn.dataset.watchToggle);
    const found = [...asArray(state.home.trending), ...asArray(state.home.popular), ...asArray(state.home.topRated), ...asArray(state.home.airing), ...asArray(state.home.upcoming), ...asArray(state.home.genre)].find(x => Number(x.id) === id);
    if (found) toggleWatchlist(found);
  }));
}

document.addEventListener("click", e => {
  const hero = e.target.closest("[data-hero-index]");
  if (hero) { state.heroIndex = Number(hero.dataset.heroIndex); renderHome(); return; }

  const genre = e.target.closest("[data-genre]");
  if (genre) { const g = genre.dataset.genre; routeTo(g === "All" ? "#home" : `#browse/${encodeURIComponent(g)}`); return; }

  const recent = e.target.closest("[data-recent-search]");
  if (recent) { searchInput.value = recent.dataset.recentSearch; doSearch(recent.dataset.recentSearch); return; }

  const more = e.target.closest("[data-see-section]");
  if (more) {
    const id = more.dataset.seeSection;
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  if (e.target.closest("[data-close-overlay]")) closeSearch();
});

function bindGlobalSearchEvents() {
  if (!searchInput) return;
  searchInput.addEventListener("input", debouncedSearch);
  searchInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && searchInput.value.trim()) {
      event.preventDefault();
      doSearch(searchInput.value);
    }
  });
}

window.addEventListener("hashchange", renderCurrentRoute);

/* -------------------------------- Keyboard -------------------------------- */

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if (!searchOverlay.classList.contains("hidden")) closeSearch();
    if (state.modal === "settings") closeSettings();
    return;
  }
  if (e.key === "/" && document.activeElement !== searchInput && !e.ctrlKey && !e.metaKey) {
    e.preventDefault(); openSearch(); return;
  }
  if (e.key === "p" && state.route === "home" && searchOverlay.classList.contains("hidden")) {
    clearInterval(state.heroTimer);
    showToast("Spotlight autoplay paused");
  }
  if (!searchOverlay.classList.contains("hidden") || state.modal) return;
  if (state.route === "home" && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    const max = Math.min(8, asArray(state.home.trending).length || 1);
    state.heroIndex = e.key === "ArrowRight" ? (state.heroIndex + 1) % max : (state.heroIndex - 1 + max) % max;
    const y = window.scrollY; renderHome(); window.scrollTo(0, y);
  }
});

/* -------------------------------- Error / boot -------------------------------- */

function renderError(title, detail) {
  app.innerHTML = `${navbar()}<main class="min-h-screen pt-[70px]"><div class="mx-auto max-w-[720px] px-5 py-28 text-center"><div class="text-4xl">⚠</div><h1 class="mt-4 text-2xl font-semibold">${escapeHTML(title)}</h1><p class="mt-3 text-sm leading-6 text-white/38">${escapeHTML(detail || "Unknown error")}</p><a href="#home" class="btn-primary mt-6 inline-flex h-11 items-center px-5 text-sm">Back home</a></div></main>`;
  bindCommon();
}

async function renderCurrentRoute() {
  const route = getRoute();
  if (route.name === "anime") return renderDetails(route.id);
  if (route.name === "watch") return renderPlayer(route.id, route.ep);
  if (route.name === "watchlist") return renderWatchlist();
  if (route.name === "history") return renderHistory();
  if (route.name === "browse") return renderBrowse(route.genre);
  return bootHome();
}

/* ------------------------------------------------------------------
   DIRECT ANILIST HOME DATA LOADER
   ------------------------------------------------------------------
   This function intentionally uses fetch() directly against the
   AniList GraphQL endpoint and renders the response into the main
   grid. It is separate from the SPA route loader, so a static UI
   can still receive anime cards immediately on page load.
   ------------------------------------------------------------------ */
async function fetchTrendingAnime() {
  const grid = document.querySelector("#mainAnimeGrid");
  if (!grid) return [];

  const query = `
    query TrendingAndPopular {
      trending: Page(page: 1, perPage: 18) {
        media(sort: TRENDING_DESC, type: ANIME, isAdult: false) {
          id
          idMal
          title { romaji english native }
          coverImage { large extraLarge }
          bannerImage
          averageScore
          popularity
          episodes
          format
          status
          seasonYear
        }
      }
      popular: Page(page: 1, perPage: 18) {
        media(sort: POPULARITY_DESC, type: ANIME, isAdult: false) {
          id
          idMal
          title { romaji english native }
          coverImage { large extraLarge }
          bannerImage
          averageScore
          popularity
          episodes
          format
          status
          seasonYear
        }
      }
    }
  `;

  // Show an explicit loading state before the network request.
  grid.innerHTML = `
    ${Array.from({ length: 12 }, () => `
      <div class="anime-card">
        <div class="anime-poster skeleton"></div>
        <div class="mt-2 h-4 w-4/5 rounded skeleton"></div>
        <div class="mt-2 h-3 w-1/2 rounded skeleton"></div>
      </div>
    `).join("")}
  `;

  try {
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json"
      },
      body: JSON.stringify({ query })
    });

    if (!response.ok) {
      throw new Error(`AniList HTTP ${response.status}`);
    }

    const json = await response.json();
    if (json.errors?.length) {
      throw new Error(json.errors.map(error => error.message).join("; "));
    }

    const trending = asArray(json?.data?.trending?.media);
    const popular = asArray(json?.data?.popular?.media);

    // Merge both lists while removing duplicate AniList IDs.
    const seen = new Set();
    const anime = [...trending, ...popular].filter(media => {
      if (!media?.id || seen.has(media.id)) return false;
      seen.add(media.id);
      return true;
    });

    // The requested dynamic response -> HTML card -> main grid path.
    grid.innerHTML = anime.length
      ? anime.map(media => createAnimeCard(media)).join("")
      : `<div class="empty-state col-span-full"><h3 class="text-lg font-semibold">No anime returned</h3><p class="mt-2 text-sm text-white/40">AniList returned an empty catalog.</p></div>`;

    bindCards();
    return anime;
  } catch (error) {
    console.error("AniList fetchTrendingAnime() failed:", error);
    grid.innerHTML = `
      <div class="empty-state col-span-full">
        <h3 class="text-lg font-semibold">Anime data could not be loaded</h3>
        <p class="mt-2 text-sm leading-6 text-white/40">
          Check your internet connection or try again. AniList response: ${escapeHTML(error.message)}
        </p>
        <button class="btn-secondary mt-5 h-10 px-4 text-sm" id="retryAniList">Retry</button>
      </div>
    `;
    document.querySelector("#retryAniList")?.addEventListener("click", fetchTrendingAnime);
    return [];
  }
}

/* ------------------------------------------------------------------
   App bootstrap
   ------------------------------------------------------------------
   IMPORTANT: The AniList request is intentionally started from
   DOMContentLoaded so the UI containers and search elements exist.
   This guarantees the initial fetch is connected to the rendered UI.
   ------------------------------------------------------------------ */
async function initApp() {
  const s = getSettings();
  document.documentElement.classList.toggle("reduce-motion", !!s.reduceMotion);
  document.documentElement.classList.toggle("no-blur", !s.blurUI);
  document.documentElement.classList.toggle("compact-mode", !!s.compactCards);
  bindGlobalSearchEvents();

  // Render the SPA shell first so #mainAnimeGrid exists, then run the
  // explicit fetch() loader requested for the static UI.
  await renderCurrentRoute();

  // Direct page-load AniList request -> JSON -> dynamic card HTML -> grid.
  if (getRoute().name === "home") {
    await fetchTrendingAnime();
  }
}

document.addEventListener("DOMContentLoaded", initApp, { once: true });
