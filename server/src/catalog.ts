export const products = [
  {
    id: "daybreak-mug",
    name: "Daybreak Mug",
    description: "A little sunshine for your daily ritual. Ceramic, 350 ml.",
    amountMinor: 1800,
    currency: "EUR",
    category: "THE DAILY RITUAL",
    art: "mug",
    color: "peach",
    translations: { de: { name: "Morgensonne-Tasse", description: "Ein bisschen Sonne für dein tägliches Ritual. Keramik, 350 ml." } },
  },
  {
    id: "weekend-tote",
    name: "Weekend Tote",
    description: "Room for your essentials. And a few spontaneous plans.",
    amountMinor: 2400,
    currency: "EUR",
    category: "THE EVERYDAY COMPANION",
    art: "tote",
    color: "sage",
    translations: { de: { name: "Wochenendtasche", description: "Platz für alles Wichtige. Und ein paar spontane Pläne." } },
  },
  {
    id: "cloud-headphones",
    name: "Cloud Nine Headphones",
    description: "Find your soundtrack. Soft cushions, wireless freedom.",
    amountMinor: 7900,
    currency: "EUR",
    category: "THE MOMENT OF ESCAPE",
    art: "headphones",
    color: "lavender",
    translations: { de: { name: "Wolke-sieben-Kopfhörer", description: "Dein Soundtrack. Weiche Polster und kabellose Freiheit." } },
  },
] as const;

export type Product = (typeof products)[number];
export const money = (minor: number) => (minor / 100).toFixed(2);
