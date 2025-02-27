import * as jose from 'jose';
import { CookieJar } from 'tough-cookie';
import { getConfig, TransientStore } from '../../src/auth0-session/';
import { signing } from '../../src/auth0-session/utils/hkdf';
import { defaultConfig, fromCookieJar, get, getCookie, toSignedCookieJar } from './fixtures/helpers';
import { setup as createServer, teardown } from './fixtures/server';
import { NodeRequest, NodeResponse } from '../../src/auth0-session/http';

const generateSignature = async (cookie: string, value: string): Promise<string> => {
  const key = await signing(defaultConfig.secret as string);
  const { signature } = await new jose.FlattenedSign(new TextEncoder().encode(`${cookie}=${value}`))
    .setProtectedHeader({ alg: 'HS256', b64: false, crit: ['b64'] })
    .sign(key);
  return signature;
};

const setup = async (
  params = defaultConfig,
  cb: (req: NodeRequest, res: NodeResponse) => Promise<string | undefined>,
  https = true
): Promise<string> =>
  createServer(params, {
    customListener: async (req, res) => {
      const value = await cb(new NodeRequest(req), new NodeResponse(res));
      res.end(JSON.stringify({ value }));
    },
    https
  });

describe('TransientStore', () => {
  afterEach(teardown);

  it('should use the passed-in key to set the cookies', async () => {
    const baseURL: string = await setup(defaultConfig, async (req: NodeRequest, res: NodeResponse) =>
      transientStore.save('test_key', req, res, { value: 'foo' })
    );
    const transientStore: TransientStore = new TransientStore(getConfig({ ...defaultConfig, baseURL }));
    const cookieJar = new CookieJar();
    const { value } = await get(baseURL, '/', { cookieJar });
    const cookies = fromCookieJar(cookieJar, baseURL);
    expect(value).toEqual('foo');
    expect(value).toEqual(cookies['test_key']);
    expect(value).toEqual(cookies['_test_key']);
  });

  it('should accept list of secrets', async () => {
    const config = { ...defaultConfig, secret: ['__old_secret__', defaultConfig.secret as string] };
    const baseURL: string = await setup(config, (req: NodeRequest, res: NodeResponse) =>
      transientStore.save('test_key', req, res, { value: 'foo' })
    );
    const transientStore = new TransientStore(getConfig({ ...config, baseURL }));
    const cookieJar = new CookieJar();
    const { value } = await get(baseURL, '/', { cookieJar });
    const cookies = fromCookieJar(cookieJar, baseURL);
    expect(value).toEqual('foo');
    expect(value).toEqual(cookies['test_key']);
    expect(value).toEqual(cookies['_test_key']);
  });

  it('should set cookie to secure by default when baseURL protocol is https', async () => {
    const baseURL: string = await setup(defaultConfig, (req: NodeRequest, res: NodeResponse) =>
      transientStore.save('test_key', req, res, { value: 'foo' })
    );
    const transientStore = new TransientStore(getConfig({ ...defaultConfig, baseURL }));
    const cookieJar = new CookieJar();
    const { value } = await get(baseURL, '/', { cookieJar });
    const cookie = getCookie('test_key', cookieJar, baseURL);
    expect(value).toEqual('foo');
    expect(cookie?.secure).toEqual(true);
  });

  it('should set cookie to not secure when baseURL protocol is http and SameSite=Lax', async () => {
    const baseURL: string = await setup(
      defaultConfig,
      (req: NodeRequest, res: NodeResponse) => transientStore.save('test_key', req, res, { value: 'foo' }),
      false
    );
    const transientStore = new TransientStore(getConfig({ ...defaultConfig, baseURL }));
    const cookieJar = new CookieJar();
    const { value } = await get(baseURL, '/', { cookieJar });
    const cookie = getCookie('test_key', cookieJar, baseURL);
    expect(value).toEqual(expect.any(String));
    expect(cookie?.secure).toBeFalsy();
  });

  it('should not set SameSite and set Secure=False for fallback cookie by default for http', async () => {
    const baseURL: string = await setup(
      defaultConfig,
      (req: NodeRequest, res: NodeResponse) => {
        return transientStore.save('test_key', req, res, { value: 'foo' });
      },
      false
    );
    const transientStore = new TransientStore(getConfig({ ...defaultConfig, baseURL }));
    const cookieJar = new CookieJar();
    const { value } = await get(baseURL, '/', { cookieJar });
    const fallbackCookie = getCookie('_test_key', cookieJar, baseURL);
    expect(value).toEqual(expect.any(String));
    expect(fallbackCookie).toMatchObject({
      sameSite: undefined,
      secure: false,
      httpOnly: true
    });
  });

  it('should turn off fallback', async () => {
    const baseURL: string = await setup(
      { ...defaultConfig, legacySameSiteCookie: false },
      (req: NodeRequest, res: NodeResponse) => transientStore.save('test_key', req, res, { value: 'foo' })
    );
    const transientStore = new TransientStore(getConfig({ ...defaultConfig, baseURL, legacySameSiteCookie: false }));
    const cookieJar = new CookieJar();
    const { value } = await get(baseURL, '/', { cookieJar });
    const cookies = fromCookieJar(cookieJar, baseURL);
    expect(value).toEqual('foo');
    expect(cookies).not.toHaveProperty('_test_key');
  });

  it('should set custom SameSite with no fallback', async () => {
    const baseURL: string = await setup(defaultConfig, (req: NodeRequest, res: NodeResponse) =>
      transientStore.save('test_key', req, res, { sameSite: 'lax', value: 'foo' })
    );
    const transientStore = new TransientStore(getConfig({ ...defaultConfig, baseURL }));
    const cookieJar = new CookieJar();
    const { value } = await get(baseURL, '/', { cookieJar });
    const cookies = fromCookieJar(cookieJar, baseURL);
    const cookie = getCookie('test_key', cookieJar, baseURL);
    expect(value).toEqual('foo');
    expect(cookies).not.toHaveProperty('_test_key');
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      value: expect.stringMatching(/^foo\..+/)
    });
  });

  it('should return undefined if there are no cookies', async () => {
    const baseURL: string = await setup(defaultConfig, (req: NodeRequest, res: NodeResponse) =>
      transientStore.read('test_key', req, res)
    );
    const transientStore = new TransientStore(getConfig({ ...defaultConfig, baseURL }));
    const { value } = await get(baseURL, '/');
    expect(value).toBeUndefined();
  });

  it('should return main value and delete both cookies by default', async () => {
    const baseURL: string = await setup(defaultConfig, (req: NodeRequest, res: NodeResponse) =>
      transientStore.read('test_key', req, res)
    );
    const transientStore = new TransientStore(getConfig({ ...defaultConfig, baseURL }));
    const cookieJar = await toSignedCookieJar(
      {
        test_key: `foo.${await generateSignature('test_key', 'foo')}`,
        _test_key: `foo.${await generateSignature('_test_key', 'foo')}`
      },
      baseURL
    );

    const { value } = await get(baseURL, '/', { cookieJar });
    const cookies = fromCookieJar(cookieJar, baseURL);
    expect(value).toEqual('foo');
    expect(cookies).not.toHaveProperty('test_key');
    expect(cookies).not.toHaveProperty('_test_key');
  });

  it('should return fallback value and delete both cookies if main value not present', async () => {
    const baseURL: string = await setup(defaultConfig, (req: NodeRequest, res: NodeResponse) =>
      transientStore.read('test_key', req, res)
    );
    const transientStore = new TransientStore(getConfig({ ...defaultConfig, baseURL }));
    const cookieJar = await toSignedCookieJar(
      {
        _test_key: `foo.${await generateSignature('_test_key', 'foo')}`
      },
      baseURL
    );
    const { value } = await get(baseURL, '/', { cookieJar });
    const cookies = fromCookieJar(cookieJar, baseURL);
    expect(value).toEqual('foo');
    expect(cookies).not.toHaveProperty('test_key');
    expect(cookies).not.toHaveProperty('_test_key');
  });

  it('should not check fallback value when legacySameSiteCookie is false', async () => {
    const baseURL: string = await setup(
      { ...defaultConfig, legacySameSiteCookie: false },
      (req: NodeRequest, res: NodeResponse) => transientStore.read('test_key', req, res)
    );
    const transientStore = new TransientStore(getConfig({ ...defaultConfig, baseURL, legacySameSiteCookie: false }));
    const cookieJar = await toSignedCookieJar(
      {
        _test_key: `foo.${await generateSignature('_test_key', 'foo')}`
      },
      baseURL
    );
    const { value } = await get(baseURL, '/', { cookieJar });
    const cookies = fromCookieJar(cookieJar, baseURL);
    expect(value).toBeUndefined();
    expect(cookies).toHaveProperty('_test_key');
  });

  it("should not throw when it can't verify the signature", async () => {
    const baseURL: string = await setup(defaultConfig, (req, res) => transientStore.read('test_key', req, res));
    const transientStore = new TransientStore(getConfig({ ...defaultConfig, baseURL }));
    const cookieJar = await toSignedCookieJar(
      {
        test_key: 'foo.bar',
        _test_key: 'foo.bar'
      },
      baseURL
    );

    const { value } = await get(baseURL, '/', { cookieJar });
    expect(value).toBeUndefined();
  });
});
