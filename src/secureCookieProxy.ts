/**
 * Add proxy to local mock server or production server.
 */
import { ClientRequest, IncomingMessage } from 'http';
import { Config as ProxyOptions } from 'http-proxy-middleware';
import { getPassword, setPassword } from 'keytar';
import { parse as parseCookies, serialize as serializeCookie } from 'cookie';
import * as inquirer from 'inquirer';

const SERVICE = 'HttpProxySecureCookies';

type Cookies = { [key: string]: string };

/**
 * Serialize cookies object to the cookie string as seen in request headers.
 */
function toCookieString(cookies: Cookies) {
  return Object.entries(cookies)
    .map(([key, value]) => serializeCookie(key, value))
    .join('; ');
}

/**
 * Parse the `Set-Cookie` header from remote servers.
 */
function parseSetCookie(
  cookieHeaders?: string | number | string[],
): [string[], Cookies] {
  if (!cookieHeaders) return [[], {}];
  const cookieArray = Array.isArray(cookieHeaders)
    ? cookieHeaders
    : [String(cookieHeaders)];
  const cookies: Cookies = {};
  return [
    cookieArray,
    cookieArray
      .map((x) => x.split(';', 1)[0].split('=', 2))
      .reduce((acc, [key, value]) => {
        acc[key] = value;
        return acc;
      }, cookies),
  ];
}

export interface SecureCookieProxyOptions extends ProxyOptions {
  /**
   * Target proxy destination.
   */
  target: string; // make proxy target a required option
  /**
   * HTTP status code indicating when auth cookies are needed (default: 401).
   */
  unauthorizedStatusCode?: number | number[];
  /**
   * The account name for the cookies saved in keychain.
   */
  keychainAccount?: string;
  /**
   * Additional processing on secure cookies before setting them to the client.
   */
  cookieRewrite?: (cookies: Cookies) => Cookies;
}

/**
 * Generate a proxy config that points to a remote host.
 */
export default function secureCookieProxy(
  options: string | SecureCookieProxyOptions,
): ProxyOptions {
  const {
    target,
    keychainAccount,
    unauthorizedStatusCode = [401],
    cookieRewrite,
    ...restOptions
  }: SecureCookieProxyOptions =
    typeof options === 'string' ? { target: options } : options;
  // default account is the target sans protocol
  const account = keychainAccount || target.split('://')[1];
  const unauthroizedCode = new Set(
    Array.isArray(unauthorizedStatusCode)
      ? unauthorizedStatusCode
      : [unauthorizedStatusCode],
  );

  let secureCookies: Cookies | undefined;
  let waitingForInput = false;

  async function getFromKeyChain() {
    return getPassword(SERVICE, account);
  }

  async function askForUserInput(message: string): Promise<string | null> {
    waitingForInput = true;
    const { cookieString } = await inquirer.prompt<{ cookieString: string }>([
      {
        type: 'password',
        name: 'cookieString',
        message,
      },
    ]);
    await setPassword(SERVICE, account, cookieString);
    waitingForInput = false;
    console.log('\nSuccessfully saved your cookie. Please refresh.');
    return cookieString;
  }

  /**
   * Read cookies from keychain or user input.
   */
  async function getCookies(message?: string) {
    if (waitingForInput) return null;
    try {
      secureCookies = parseCookies(
        (message ? await askForUserInput(message) : await getFromKeyChain()) ||
          '',
      );
    } catch {
      await getCookies('Invalid cookie string, please try again: ');
    }
    return secureCookies;
  }

  /**
   * Add secure cookies to proxy request header
   */
  function addCookie(proxyReq: ClientRequest, req: IncomingMessage) {
    proxyReq.setHeader(
      'cookie',
      toCookieString({
        ...secureCookies,
        ...parseCookies(req.headers.cookie || ''),
      }),
    );
  }

  // quitely get initial cookies
  getCookies();

  return {
    secure: false,
    changeOrigin: true,
    target,
    ws: target.startsWith('ws'),
    ...restOptions,
    onProxyReq: addCookie,
    onProxyReqWs: addCookie,
    onProxyRes(proxyRes, req, res) {
      // update cookies if API returns 401
      if (proxyRes.statusCode && unauthroizedCode.has(proxyRes.statusCode)) {
        getCookies(`
Authentication failed for ${target}${req.url}

You either haven't provide an auth cookie or it expired.
Please login to ${target} and copy the HTTP cookie string here.

It will be securely stored in system keychain:`);
      }
      // add missing cookies to the response so they can be used on the client
      // side as well.
      if (secureCookies) {
        const reqCookies = parseCookies(req.headers.cookie || '');
        const [cookieHeaders, resCookies] = parseSetCookie(
          res.getHeader('set-cookie'),
        );
        const clientCookies = cookieRewrite
          ? cookieRewrite(secureCookies)
          : secureCookies;
        let hasMissingCookie = false;
        Object.keys(clientCookies).forEach((key) => {
          if (!(key in reqCookies) && !(key in resCookies)) {
            // set all secure cookie to the root path
            cookieHeaders.push(
              serializeCookie(key, clientCookies[key], { path: '/' }),
            );
            hasMissingCookie = true;
          }
        });
        if (hasMissingCookie) {
          res.setHeader('Set-Cookie', cookieHeaders);
        }
      }
    },
  };
}