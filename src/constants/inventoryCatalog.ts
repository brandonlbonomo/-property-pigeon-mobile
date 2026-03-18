// ── Inventory Catalog ──
// Static bank of item types with default depletion rates per guest stay.
// When perStay is 0 and isStatic is false, the item depletes but has no
// meaningful guest-facing default (e.g., cleaning supplies used by cleaners).

export type InventoryCategory =
  | 'bath_body'
  | 'paper_tissue'
  | 'cleaning'
  | 'kitchen'
  | 'snacks_beverages'
  | 'linens'
  | 'supplies_maintenance';

export interface CatalogItem {
  name: string;
  category: InventoryCategory;
  defaultUnit: '' | 'oz' | 'gal';
  defaultPerStay: number;
  /** Alternate rate when "Cleaner Only" is toggled (cleaning category) */
  cleanerPerStay?: number;
  /** Static items never deplete (linens, maintenance parts) */
  isStatic: boolean;
}

export interface CategoryMeta {
  key: InventoryCategory;
  label: string;
  icon: string; // Ionicons name
  hasCleanerToggle: boolean;
}

// ── Categories ──

export const CATEGORIES: CategoryMeta[] = [
  { key: 'bath_body',            label: 'Bath & Body',    icon: 'water-outline',       hasCleanerToggle: false },
  { key: 'paper_tissue',         label: 'Paper & Tissue', icon: 'newspaper-outline',   hasCleanerToggle: false },
  { key: 'cleaning',             label: 'Cleaning',       icon: 'sparkles-outline',    hasCleanerToggle: true },
  { key: 'kitchen',              label: 'Kitchen',        icon: 'cafe-outline',        hasCleanerToggle: false },
  { key: 'snacks_beverages',     label: 'Snacks & Drinks',icon: 'fast-food-outline',   hasCleanerToggle: false },
  { key: 'linens',               label: 'Linens',         icon: 'bed-outline',         hasCleanerToggle: false },
  { key: 'supplies_maintenance', label: 'Supplies',       icon: 'construct-outline',   hasCleanerToggle: false },
];

// ── Full Item Catalog ──

export const CATALOG_ITEMS: CatalogItem[] = [
  // ─── Bath & Body ───
  { name: 'Hand Soap',             category: 'bath_body', defaultUnit: 'oz',  defaultPerStay: 2,    isStatic: false },
  { name: 'Bar Soap',              category: 'bath_body', defaultUnit: '',    defaultPerStay: 1,    isStatic: false },
  { name: 'Shampoo',               category: 'bath_body', defaultUnit: 'oz',  defaultPerStay: 1.5,  isStatic: false },
  { name: 'Conditioner',           category: 'bath_body', defaultUnit: 'oz',  defaultPerStay: 1.5,  isStatic: false },
  { name: 'Body Wash',             category: 'bath_body', defaultUnit: 'oz',  defaultPerStay: 2,    isStatic: false },
  { name: 'Lotion',                category: 'bath_body', defaultUnit: 'oz',  defaultPerStay: 1,    isStatic: false },
  { name: 'Toothbrush',            category: 'bath_body', defaultUnit: '',    defaultPerStay: 0.5,  isStatic: false },
  { name: 'Toothpaste',            category: 'bath_body', defaultUnit: '',    defaultPerStay: 0.3,  isStatic: false },
  { name: 'Mouthwash',             category: 'bath_body', defaultUnit: 'oz',  defaultPerStay: 1,    isStatic: false },
  { name: 'Razor',                 category: 'bath_body', defaultUnit: '',    defaultPerStay: 0.3,  isStatic: false },
  { name: 'Shower Cap',            category: 'bath_body', defaultUnit: '',    defaultPerStay: 1,    isStatic: false },
  { name: 'Cotton Balls',          category: 'bath_body', defaultUnit: '',    defaultPerStay: 3,    isStatic: false },
  { name: 'Q-Tips',                category: 'bath_body', defaultUnit: '',    defaultPerStay: 4,    isStatic: false },
  { name: 'Makeup Remover Wipes',  category: 'bath_body', defaultUnit: '',    defaultPerStay: 2,    isStatic: false },
  { name: 'Floss',                 category: 'bath_body', defaultUnit: '',    defaultPerStay: 0.5,  isStatic: false },
  { name: 'Hair Ties',             category: 'bath_body', defaultUnit: '',    defaultPerStay: 1,    isStatic: false },
  { name: 'Shower Gel',            category: 'bath_body', defaultUnit: 'oz',  defaultPerStay: 2,    isStatic: false },
  { name: 'Bubble Bath',           category: 'bath_body', defaultUnit: 'oz',  defaultPerStay: 2,    isStatic: false },
  { name: 'Bath Bomb',             category: 'bath_body', defaultUnit: '',    defaultPerStay: 0.3,  isStatic: false },

  // ─── Paper & Tissue ───
  { name: 'Toilet Paper',          category: 'paper_tissue', defaultUnit: '',  defaultPerStay: 2,    isStatic: false },
  { name: 'Paper Towels',          category: 'paper_tissue', defaultUnit: '',  defaultPerStay: 1,    isStatic: false },
  { name: 'Facial Tissue',         category: 'paper_tissue', defaultUnit: '',  defaultPerStay: 0.5,  isStatic: false },
  { name: 'Napkins',               category: 'paper_tissue', defaultUnit: '',  defaultPerStay: 4,    isStatic: false },

  // ─── Cleaning (guest perStay / cleaner perStay) ───
  { name: 'Laundry Detergent',     category: 'cleaning', defaultUnit: 'oz',  defaultPerStay: 0,   cleanerPerStay: 6,   isStatic: false },
  { name: 'Dish Soap',             category: 'cleaning', defaultUnit: 'oz',  defaultPerStay: 1,   cleanerPerStay: 2,   isStatic: false },
  { name: 'All-Purpose Cleaner',   category: 'cleaning', defaultUnit: 'oz',  defaultPerStay: 0,   cleanerPerStay: 4,   isStatic: false },
  { name: 'Glass Cleaner',         category: 'cleaning', defaultUnit: 'oz',  defaultPerStay: 0,   cleanerPerStay: 2,   isStatic: false },
  { name: 'Bleach',                category: 'cleaning', defaultUnit: 'oz',  defaultPerStay: 0,   cleanerPerStay: 2,   isStatic: false },
  { name: 'Sponge',                category: 'cleaning', defaultUnit: '',    defaultPerStay: 0,   cleanerPerStay: 0.1, isStatic: false },
  { name: 'Trash Bags',            category: 'cleaning', defaultUnit: '',    defaultPerStay: 2,   cleanerPerStay: 3,   isStatic: false },
  { name: 'Dryer Sheets',          category: 'cleaning', defaultUnit: '',    defaultPerStay: 0,   cleanerPerStay: 4,   isStatic: false },
  { name: 'Dishwasher Pods',       category: 'cleaning', defaultUnit: '',    defaultPerStay: 0,   cleanerPerStay: 2,   isStatic: false },
  { name: 'Disinfectant Wipes',    category: 'cleaning', defaultUnit: '',    defaultPerStay: 0,   cleanerPerStay: 3,   isStatic: false },
  { name: 'Disinfectant Spray',    category: 'cleaning', defaultUnit: 'oz',  defaultPerStay: 0,   cleanerPerStay: 3,   isStatic: false },
  { name: 'Fabric Softener',       category: 'cleaning', defaultUnit: 'oz',  defaultPerStay: 0,   cleanerPerStay: 3,   isStatic: false },
  { name: 'Stain Remover',         category: 'cleaning', defaultUnit: 'oz',  defaultPerStay: 0,   cleanerPerStay: 1,   isStatic: false },
  { name: 'Toilet Bowl Cleaner',   category: 'cleaning', defaultUnit: 'oz',  defaultPerStay: 0,   cleanerPerStay: 3,   isStatic: false },
  { name: 'Vacuum Bags',           category: 'cleaning', defaultUnit: '',    defaultPerStay: 0,   cleanerPerStay: 0.05,isStatic: false },

  // ─── Kitchen ───
  { name: 'Coffee Pods',           category: 'kitchen', defaultUnit: '',    defaultPerStay: 4,    isStatic: false },
  { name: 'Ground Coffee',         category: 'kitchen', defaultUnit: 'oz',  defaultPerStay: 2,    isStatic: false },
  { name: 'Tea Bags',              category: 'kitchen', defaultUnit: '',    defaultPerStay: 2,    isStatic: false },
  { name: 'Sugar Packets',         category: 'kitchen', defaultUnit: '',    defaultPerStay: 4,    isStatic: false },
  { name: 'Creamer Cups',          category: 'kitchen', defaultUnit: '',    defaultPerStay: 4,    isStatic: false },
  { name: 'Sweetener Packets',     category: 'kitchen', defaultUnit: '',    defaultPerStay: 2,    isStatic: false },
  { name: 'Ziploc Bags',           category: 'kitchen', defaultUnit: '',    defaultPerStay: 2,    isStatic: false },
  { name: 'Aluminum Foil',         category: 'kitchen', defaultUnit: '',    defaultPerStay: 0.1,  isStatic: false },
  { name: 'Plastic Wrap',          category: 'kitchen', defaultUnit: '',    defaultPerStay: 0.1,  isStatic: false },
  { name: 'Cooking Oil',           category: 'kitchen', defaultUnit: 'oz',  defaultPerStay: 0.5,  isStatic: false },
  { name: 'Salt & Pepper',         category: 'kitchen', defaultUnit: '',    defaultPerStay: 0,    isStatic: true },
  { name: 'Paper Plates',          category: 'kitchen', defaultUnit: '',    defaultPerStay: 2,    isStatic: false },
  { name: 'Plastic Cups',          category: 'kitchen', defaultUnit: '',    defaultPerStay: 2,    isStatic: false },
  { name: 'Plastic Utensils',      category: 'kitchen', defaultUnit: '',    defaultPerStay: 2,    isStatic: false },

  // ─── Snacks & Beverages ───
  { name: 'Water Bottles',         category: 'snacks_beverages', defaultUnit: '',  defaultPerStay: 4,   isStatic: false },
  { name: 'Sparkling Water',       category: 'snacks_beverages', defaultUnit: '',  defaultPerStay: 2,   isStatic: false },
  { name: 'Juice Boxes',           category: 'snacks_beverages', defaultUnit: '',  defaultPerStay: 2,   isStatic: false },
  { name: 'Chips',                 category: 'snacks_beverages', defaultUnit: '',  defaultPerStay: 1,   isStatic: false },
  { name: 'Granola Bars',          category: 'snacks_beverages', defaultUnit: '',  defaultPerStay: 2,   isStatic: false },
  { name: 'Popcorn',               category: 'snacks_beverages', defaultUnit: '',  defaultPerStay: 1,   isStatic: false },
  { name: 'Cookies',               category: 'snacks_beverages', defaultUnit: '',  defaultPerStay: 1,   isStatic: false },
  { name: 'Candy',                 category: 'snacks_beverages', defaultUnit: '',  defaultPerStay: 1,   isStatic: false },
  { name: 'Trail Mix',             category: 'snacks_beverages', defaultUnit: '',  defaultPerStay: 0.5, isStatic: false },
  { name: 'Wine',                  category: 'snacks_beverages', defaultUnit: '',  defaultPerStay: 0,   isStatic: false },
  { name: 'Beer',                  category: 'snacks_beverages', defaultUnit: '',  defaultPerStay: 0,   isStatic: false },
  { name: 'Soda',                  category: 'snacks_beverages', defaultUnit: '',  defaultPerStay: 2,   isStatic: false },

  // ─── Linens (all static) ───
  { name: 'Bath Towel',            category: 'linens', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Hand Towel',            category: 'linens', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Washcloth',             category: 'linens', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Sheet Set (King)',      category: 'linens', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Sheet Set (Queen)',     category: 'linens', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Sheet Set (Twin)',      category: 'linens', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Pillowcase',            category: 'linens', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Pillow',                category: 'linens', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Comforter',             category: 'linens', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Duvet Cover',           category: 'linens', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Blanket',               category: 'linens', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Mattress Protector',    category: 'linens', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Bathrobe',              category: 'linens', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },

  // ─── Supplies & Maintenance (all static) ───
  { name: 'Light Bulb',            category: 'supplies_maintenance', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Battery (AA)',          category: 'supplies_maintenance', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Battery (AAA)',         category: 'supplies_maintenance', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Air Filter',            category: 'supplies_maintenance', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Smoke Detector Battery',category: 'supplies_maintenance', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Fire Extinguisher',     category: 'supplies_maintenance', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Door Lock Battery',     category: 'supplies_maintenance', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Remote Battery',        category: 'supplies_maintenance', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'HVAC Filter',           category: 'supplies_maintenance', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Hanger',                category: 'supplies_maintenance', defaultUnit: '',  defaultPerStay: 0,  isStatic: true },
  { name: 'Welcome Card',          category: 'supplies_maintenance', defaultUnit: '',  defaultPerStay: 1,  isStatic: false },
];

// ── Helpers ──

export function getCatalogByCategory(category: InventoryCategory): CatalogItem[] {
  return CATALOG_ITEMS.filter(i => i.category === category);
}

export function findCatalogItem(name: string): CatalogItem | undefined {
  const lower = name.toLowerCase();
  return CATALOG_ITEMS.find(i => i.name.toLowerCase() === lower);
}

export function getCategoryMeta(key: InventoryCategory): CategoryMeta | undefined {
  return CATEGORIES.find(c => c.key === key);
}
