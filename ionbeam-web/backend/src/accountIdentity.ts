import { ConfigError } from "./configManager";
import type { AdminUser } from "./adminDbRepository";

/** Missing identity and unavailable identity storage must have different outcomes. */
export async function accountIdentity(
  lookup: () => Promise<AdminUser | null>, fallback: () => AdminUser | null,
): Promise<AdminUser | null> {
  try {
    return await lookup() ?? fallback();
  } catch {
    const user = fallback();
    if (user) return user;
    throw new ConfigError("Account lookup temporarily unavailable. Please try again.", 503);
  }
}
