import { expect, openApp, test } from './fixtures'

// The other specs prove the app works under the policy (the fixture fails them on any violation). This one
// proves the policy is there and blocks what it is for, so a lost header cannot pass as "no violations".

test('every private app document carries the CSP, including paths the SPA fallback answers', async ({ page }) => {
  for (const path of ['/', '/albums', '/no-such-page']) {
    const res = await page.goto(path)
    const csp = res?.headers()['content-security-policy'] ?? ''
    expect(csp, path).toContain("default-src 'self'")
    expect(csp, path).toMatch(/script-src 'self'( 'nonce-[\w-]+')?;/)
    expect(csp, path).toContain("object-src 'none'")
    expect(csp, path).toContain("base-uri 'none'")
    expect(csp, path).toContain("frame-ancestors 'none'")
    expect(csp, path).not.toContain('unsafe-')
  }
})

// What markup injected into the page (a title rendered as HTML, say) would try: an inline <script>, an inline
// event handler, and an image that carries data to another origin. eval() is refused by the header alone (no
// 'unsafe-eval', checked above); page.evaluate() cannot show it, because DevTools evaluation is exempt.
test('injected markup cannot run script or send data to another origin', async ({ page, cspViolations }) => {
  await openApp(page)
  const ran = await page.evaluate(async () => {
    const w = window as unknown as { injected?: boolean; handler?: boolean }
    const script = document.createElement('script')
    script.textContent = 'window.injected = true'
    document.body.append(script)
    const div = document.createElement('div')
    div.innerHTML = '<img src="/no-such-image.png" onerror="window.handler = true">'
    document.body.append(div)
    const img = document.createElement('img')
    img.src = 'https://example.com/pixel.png?leak=1'
    document.body.append(img)
    await new Promise((resolve) => setTimeout(resolve, 500))
    return { injected: w.injected === true, handler: w.handler === true }
  })
  expect(ran).toEqual({ injected: false, handler: false })
  await expect
    .poll(() => cspViolations.map((v) => v.split(' ')[0]).sort())
    .toEqual(['img-src', 'script-src-attr', 'script-src-elem'])
  cspViolations.length = 0
})
