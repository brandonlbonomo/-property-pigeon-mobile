export function fmt$(n: number, compact = false): string {
  if (compact && Math.abs(n) >= 1000) {
    return '$' + (n / 1000).toFixed(1) + 'k';
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(n);
}

export function fmtPct(n: number): string {
  return (n * 100).toFixed(1) + '%';
}

export function fmtDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function fmtMonthYear(iso: string): string {
  if (!iso) return '';
  const [y, m] = iso.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${names[parseInt(m) - 1]} ${y}`;
}

export function isoMonth(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7);
}

export function currentYear(): number {
  return new Date().getFullYear();
}
