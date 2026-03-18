import Purchases, { CustomerInfo, PurchasesPackage } from 'react-native-purchases';
import { Platform } from 'react-native';

const API_KEY = 'appl_xydNgPtsqymlnQuXoxsLQALzvUA';
export const ENTITLEMENT_ID = 'Portfolio Pigeon Pro';

// Product identifiers (must match App Store Connect / RevenueCat)
export const PRODUCT_IDS = {
  owner_monthly: 'pp_pro_monthly',
  owner_yearly: 'pp_pro_yearly',
  cleaner_monthly: 'pp_cpro_monthly',
  cleaner_yearly: 'pp_cpro_yearly',
} as const;

export interface ProductPricing {
  monthly: { priceString: string; price: number; pkg: PurchasesPackage } | null;
  yearly: { priceString: string; price: number; monthlyEquivalent: string; pkg: PurchasesPackage } | null;
}

let configured = false;

export function configureRevenueCat() {
  if (configured || Platform.OS !== 'ios') return;
  try {
    Purchases.configure({ apiKey: API_KEY });
    configured = true;
  } catch (e) {
    // RevenueCat not available (expected in Expo Go)
  }
}

export async function identifyUser(userId: string): Promise<CustomerInfo | null> {
  if (!configured) return null;
  try {
    const { customerInfo } = await Purchases.logIn(userId);
    return customerInfo;
  } catch {
    return null;
  }
}

export async function logoutUser() {
  if (!configured) return;
  try {
    await Purchases.logOut();
  } catch {}
}

/**
 * Check if the user has an active pro subscription via RevenueCat.
 * Checks the specific entitlement ID first, then falls back to checking
 * whether ANY entitlement or active subscription exists. This prevents
 * a misconfigured entitlement ID from silently locking out paying users.
 */
export async function checkProEntitlement(): Promise<boolean> {
  if (!configured) return false;
  try {
    const customerInfo = await Purchases.getCustomerInfo();
    return isCustomerEntitled(customerInfo);
  } catch {
    return false;
  }
}

/**
 * Determine if a CustomerInfo represents an entitled user.
 * Primary check: the specific ENTITLEMENT_ID.
 * Fallback: any active entitlement or any active subscription.
 */
export function isCustomerEntitled(customerInfo: CustomerInfo): boolean {
  // Primary: exact entitlement match
  if (ENTITLEMENT_ID in customerInfo.entitlements.active) return true;
  // Fallback: any active entitlement (covers entitlement ID typos/renames)
  if (Object.keys(customerInfo.entitlements.active).length > 0) return true;
  // Fallback: any active subscription (covers entitlement not mapped to product)
  if (customerInfo.activeSubscriptions.length > 0) return true;
  return false;
}

/** @deprecated Use isCustomerEntitled instead */
export function hasEntitlement(customerInfo: CustomerInfo): boolean {
  return isCustomerEntitled(customerInfo);
}

/**
 * Fetch product prices from StoreKit via RevenueCat offerings.
 * Returns monthly and yearly packages for the given account type.
 */
export async function getProductPrices(accountType: 'owner' | 'cleaner'): Promise<ProductPricing> {
  const result: ProductPricing = { monthly: null, yearly: null };
  if (!configured) return result;

  try {
    const offerings = await Purchases.getOfferings();
    const packages = offerings.current?.availablePackages || [];

    const monthlyId = accountType === 'cleaner' ? PRODUCT_IDS.cleaner_monthly : PRODUCT_IDS.owner_monthly;
    const yearlyId = accountType === 'cleaner' ? PRODUCT_IDS.cleaner_yearly : PRODUCT_IDS.owner_yearly;

    for (const pkg of packages) {
      const pid = pkg.product.identifier;
      if (pid === monthlyId) {
        result.monthly = {
          priceString: pkg.product.priceString,
          price: pkg.product.price,
          pkg,
        };
      } else if (pid === yearlyId) {
        const yearlyPrice = pkg.product.price;
        const monthlyEq = yearlyPrice / 12;
        const currencyCode = pkg.product.currencyCode || 'USD';
        result.yearly = {
          priceString: pkg.product.priceString,
          price: yearlyPrice,
          monthlyEquivalent: new Intl.NumberFormat('en-US', {
            style: 'currency', currency: currencyCode,
          }).format(monthlyEq),
          pkg,
        };
      }
    }
  } catch {}

  return result;
}

/**
 * Purchase a specific package. Returns customerInfo on success.
 * Throws on error (check error.userCancelled for user cancellation).
 */
export async function purchaseProduct(pkg: PurchasesPackage): Promise<CustomerInfo> {
  const { customerInfo } = await Purchases.purchasePackage(pkg);
  return customerInfo;
}

/**
 * Restore previous purchases. Returns customerInfo.
 */
export async function restorePurchases(): Promise<CustomerInfo | null> {
  if (!configured) return null;
  try {
    const customerInfo = await Purchases.restorePurchases();
    return customerInfo;
  } catch {
    return null;
  }
}

export function addCustomerInfoListener(callback: (info: CustomerInfo) => void) {
  if (!configured) return { remove: () => {} };
  Purchases.addCustomerInfoUpdateListener(callback);
  return {
    remove: () => { Purchases.removeCustomerInfoUpdateListener(callback); },
  };
}
