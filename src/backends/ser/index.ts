import type { SerProvider, SerProviderConfig } from "./provider";
import { Emotion2vecProvider } from "./emotion2vec";

export type { SerProvider, SerProviderConfig, ToneResult } from "./provider";
export { Emotion2vecProvider } from "./emotion2vec";

export function createSerProvider(config: SerProviderConfig = {}): SerProvider {
  return new Emotion2vecProvider(config);
}
