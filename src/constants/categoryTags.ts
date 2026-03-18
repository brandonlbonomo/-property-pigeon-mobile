export interface CategoryDef {
  id: string;
  label: string;
  icon: string;
  color: string;
  bgColor: string;
  type: 'income' | 'expense' | 'neutral';
}

export const OWNER_CATEGORIES: CategoryDef[] = [
  { id: '__rental_income__', label: 'Rental Income', icon: 'home-outline', color: '#34D399', bgColor: 'rgba(16,185,129,0.15)', type: 'income' },
  { id: '__mortgage__', label: 'Mortgage', icon: 'business-outline', color: '#F87171', bgColor: 'rgba(239,68,68,0.15)', type: 'expense' },
  { id: '__insurance__', label: 'Insurance', icon: 'shield-checkmark-outline', color: '#A78BFA', bgColor: 'rgba(139,92,246,0.15)', type: 'expense' },
  { id: '__utilities__', label: 'Utilities', icon: 'flash-outline', color: '#FBBF24', bgColor: 'rgba(245,158,11,0.15)', type: 'expense' },
  { id: '__maintenance__', label: 'Maintenance', icon: 'hammer-outline', color: '#FB923C', bgColor: 'rgba(249,115,22,0.15)', type: 'expense' },
  { id: '__hoa__', label: 'HOA', icon: 'people-outline', color: '#818CF8', bgColor: 'rgba(99,102,241,0.15)', type: 'expense' },
  { id: '__taxes__', label: 'Taxes', icon: 'document-text-outline', color: '#2DD4BF', bgColor: 'rgba(20,184,166,0.15)', type: 'expense' },
  { id: '__cleaning__', label: 'Cleaning', icon: 'sparkles-outline', color: '#F472B6', bgColor: 'rgba(236,72,153,0.15)', type: 'expense' },
];

export const CLEANER_CATEGORIES: CategoryDef[] = [
  { id: '__cleaning_income__', label: 'Cleaning Income', icon: 'cash-outline', color: '#34D399', bgColor: 'rgba(16,185,129,0.15)', type: 'income' },
  { id: '__cleaning_supplies__', label: 'Cleaning Supplies', icon: 'cart-outline', color: '#FBBF24', bgColor: 'rgba(245,158,11,0.15)', type: 'expense' },
  { id: '__travel_fuel__', label: 'Travel & Fuel', icon: 'car-outline', color: '#FB923C', bgColor: 'rgba(249,115,22,0.15)', type: 'expense' },
  { id: '__equipment__', label: 'Equipment', icon: 'construct-outline', color: '#A78BFA', bgColor: 'rgba(139,92,246,0.15)', type: 'expense' },
];

export const SPECIAL_TAGS: CategoryDef[] = [
  { id: '__general__', label: 'General', icon: 'folder-outline', color: '#60A5FA', bgColor: 'rgba(59,130,246,0.15)', type: 'neutral' },
  { id: '__internal_transfer__', label: 'Internal Transfer', icon: 'swap-horizontal-outline', color: '#A1A1AA', bgColor: 'rgba(255,255,255,0.08)', type: 'neutral' },
  { id: '__delete__', label: 'Delete', icon: 'trash-outline', color: '#F87171', bgColor: 'rgba(239,68,68,0.15)', type: 'neutral' },
];

const ALL_CATEGORIES = [...OWNER_CATEGORIES, ...CLEANER_CATEGORIES, ...SPECIAL_TAGS];

export function getCategoryById(id: string, accountType: string): CategoryDef | undefined {
  const cats = accountType === 'cleaner' ? CLEANER_CATEGORIES : OWNER_CATEGORIES;
  return cats.find(c => c.id === id) || SPECIAL_TAGS.find(c => c.id === id);
}

export function isExcludedTag(tag: string | null): boolean {
  return tag === '__delete__' || tag === '__internal_transfer__';
}

export function isIncomeCategory(id: string): boolean {
  const def = ALL_CATEGORIES.find(c => c.id === id);
  return def?.type === 'income';
}

export function isExpenseCategory(id: string): boolean {
  const def = ALL_CATEGORIES.find(c => c.id === id);
  return def?.type === 'expense';
}
