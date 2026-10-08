import { HttpsProxyAgent } from "https-proxy-agent";
import { Agent, ProxyAgent, setGlobalDispatcher } from "undici";
import { networkSettings } from "./download";

// Behind a company or school proxy nothing gets out directly. Node's own fetch() (translation) and the Khmer
// voice's WebSocket ignore the PC's proxy settings, so they are pointed at it here. yt-dlp, aria2c, pip and
// Python already follow HTTPS_PROXY, which start.ps1 sets from Windows' own proxy setting.

const httpProxy = (p: string) => (/^https?:\/\/\S+$/i.test(p) ? p : ""); // a socks5:// proxy works for yt-dlp only
const envProxy = () => process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";

/**
 * The proxy for the app's own connections: the one in the network settings when it is an http(s) proxy, else
 * Windows' (start.ps1 puts it in HTTPS_PROXY). "" for none.
 */
export function appProxy(): string {
  return httpProxy(networkSettings().proxy) || httpProxy(envProxy());
}

let applied: string | undefined;
/** fetch() through the proxy (or straight out again); called at start and whenever the network settings change. */
export function applyProxy() {
  const p = appProxy();
  if (p === applied) return;
  applied = p;
  setGlobalDispatcher(p ? new ProxyAgent(p) : new Agent());
  if (p) console.log(`Connections go through the proxy ${p.replace(/\/\/[^@/]*@/, "//***@")}`);
}

/** For the Khmer voice's WebSocket (msedge-tts takes an agent); undefined when there is no proxy. */
export function ttsAgent() {
  const p = appProxy();
  return p ? new HttpsProxyAgent(p) : undefined;
}
