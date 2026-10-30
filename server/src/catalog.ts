export const products = [
  {
    id: "starry-night-puzzle",
    name: "Starry Night Puzzle",
    description: "Vincent van Gogh · 1,000-piece art puzzle. Piece together a swirling blue night, golden stars and a quiet village.",
    amountMinor: 2990,
    currency: "EUR",
    category: "VINCENT VAN GOGH",
    art: "starry-night",
    color: "peach",
    translations: { de: { name: "Sternennacht-Puzzle", description: "Vincent van Gogh · Kunstpuzzle mit 1.000 Teilen. Ein wirbelnder blauer Nachthimmel, goldene Sterne und ein stilles Dorf." } },
  },
  {
    id: "great-wave-puzzle",
    name: "The Great Wave Puzzle",
    description: "Katsushika Hokusai · 1,000-piece art puzzle. Discover curling indigo waves, tiny boats and distant Mount Fuji.",
    amountMinor: 2790,
    currency: "EUR",
    category: "KATSUSHIKA HOKUSAI",
    art: "great-wave",
    color: "sage",
    translations: { de: { name: "Die große Welle – Puzzle", description: "Katsushika Hokusai · Kunstpuzzle mit 1.000 Teilen. Entdecke indigoblaue Wellen, kleine Boote und den fernen Fuji." } },
  },
  {
    id: "water-lilies-puzzle",
    name: "Water Lilies Puzzle",
    description: "Claude Monet · 1,000-piece art puzzle. Slow down among floating water lilies, soft reflections and a peaceful garden pond.",
    amountMinor: 3190,
    currency: "EUR",
    category: "CLAUDE MONET",
    art: "water-lilies",
    color: "lavender",
    translations: { de: { name: "Seerosen-Puzzle", description: "Claude Monet · Kunstpuzzle mit 1.000 Teilen. Genieße schwimmende Seerosen, sanfte Spiegelungen und einen friedlichen Gartenteich." } },
  },
] as const;

export type Product = (typeof products)[number];
export const money = (minor: number) => (minor / 100).toFixed(2);
