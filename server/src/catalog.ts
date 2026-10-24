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
  },
] as const;

export type Product = (typeof products)[number];
export const money = (minor: number) => (minor / 100).toFixed(2);
