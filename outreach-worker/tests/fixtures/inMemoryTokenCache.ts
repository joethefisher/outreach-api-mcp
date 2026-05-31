import type { TokenCache, TokenCacheData } from "../../src/auth/tokenCache.js";

export class InMemoryTokenCache implements TokenCache {
  private data: TokenCacheData | null;
  public readonly writes: TokenCacheData[] = [];

  constructor(initial: TokenCacheData | null = null) {
    this.data = initial;
  }

  read(): Promise<TokenCacheData | null> {
    return Promise.resolve(this.data);
  }

  write(data: TokenCacheData): Promise<void> {
    this.data = data;
    this.writes.push(data);
    return Promise.resolve();
  }
}
