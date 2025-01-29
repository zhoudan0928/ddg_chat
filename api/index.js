import { createServerAdapter } from '@whatwg-node/server'
import { Router } from 'itty-router'
import { createServer } from 'http'
import dotenv from 'dotenv'

dotenv.config()

// 自定义实现 json、error 和 cors 功能
const json = (data) => new Response(JSON.stringify(data), {
  headers: { 'Content-Type': 'application/json' }
})

const error = (status, message) => new Response(JSON.stringify({ error: message }), {
  status,
  headers: { 'Content-Type': 'application/json' }
})

const cors = (options = {}) => {
  const {
    origin = '*',
    methods = '*',
    headers = '*',
    maxAge = 86400,
    allowCredentials = true,
  } = options

  const preflight = request => {
    if (request.method.toLowerCase() === 'options') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': methods,
          'Access-Control-Allow-Headers': headers,
          'Access-Control-Max-Age': maxAge,
          'Access-Control-Allow-Credentials': allowCredentials,
        },
      })
    }
  }

  const corsify = response => {
    response.headers.set('Access-Control-Allow-Origin', origin)
    response.headers.set('Access-Control-Allow-Methods', methods)
    response.headers.set('Access-Control-Allow-Headers', headers)
    response.headers.set('Access-Control-Allow-Credentials', allowCredentials)
    return response
  }

  return { preflight, corsify }
}

// 添加 User-Agent 生成器
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 Edg/119.0.0.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
]

const PROXY_LIST = process.env.PROXY_LIST ? JSON.parse(process.env.PROXY_LIST) : []

class Config {
  constructor() {
    this.PORT = process.env.PORT || 8787
    this.API_PREFIX = process.env.API_PREFIX || '/'
    this.API_KEY = process.env.API_KEY || ''
    this.MAX_RETRY_COUNT = process.env.MAX_RETRY_COUNT || 3
    this.RETRY_DELAY = process.env.RETRY_DELAY || 10000
    this.RETRY_DELAY_RANDOM = true
    this.USE_PROXY = process.env.USE_PROXY === 'true'
    this.ROTATE_USER_AGENT = process.env.ROTATE_USER_AGENT !== 'false'
    
    // 获取随机User-Agent
    const randomUserAgent = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
    
    this.getHeaders = () => {
      const baseHeaders = {
        Accept: '*/*',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        Origin: 'https://duckduckgo.com/',
        Cookie: `dcm=${Math.floor(Math.random() * 5) + 1}`,
        Dnt: '1',
        Priority: 'u=1, i',
        Referer: 'https://duckduckgo.com/',
        'Sec-Ch-Ua': '"Chromium";v="120", "Not?A_Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'User-Agent': this.ROTATE_USER_AGENT ? randomUserAgent() : USER_AGENTS[0],
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
      }
      return baseHeaders
    }
    
    // 初始化默认headers
    this.FAKE_HEADERS = process.env.FAKE_HEADERS || this.getHeaders()
  }

  getProxy() {
    if (!this.USE_PROXY || PROXY_LIST.length === 0) return null
    return PROXY_LIST[Math.floor(Math.random() * PROXY_LIST.length)]
  }
}

const config = new Config()

const { preflight, corsify } = cors({
  origin: '*',
  allowMethods: '*',
  exposeHeaders: '*',
})

const withBenchmarking = (request) => {
  request.start = Date.now()
}

const withAuth = (request) => {
  if (config.API_KEY) {
    const authHeader = request.headers.get('Authorization')
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return error(401, 'Unauthorized: Missing or invalid Authorization header')
    }
    const token = authHeader.substring(7)
    if (token !== config.API_KEY) {
      return error(403, 'Forbidden: Invalid API key')
    }
  }
}

const logger = (res, req) => {
  console.log(req.method, res.status, req.url, Date.now() - req.start, 'ms')
}

// 添加 URL 处理辅助函数
function normalizeUrl(url) {
  if (!url) return '/'
  try {
    const baseUrl = process.env.VERCEL 
      ? process.env.VERCEL_URL 
      : `http://localhost:${config.PORT}`
    return new URL(url, baseUrl).toString()
  } catch (e) {
    console.error('URL normalization error:', e)
    return '/'
  }
}

const router = Router({
  base: '/',
  before: [
    // 添加 URL 规范化中间件
    (request) => {
      request.normalizedUrl = normalizeUrl(request.url)
    },
    withBenchmarking,
    preflight,
    withAuth
  ],
  missing: (request) => {
    // 处理 favicon.ico 和其他静态资源请求
    if (request.normalizedUrl.endsWith('.ico') || request.normalizedUrl.endsWith('.png')) {
      return new Response(null, { status: 404 })
    }
    return error(404, '404 Not Found. Please check whether the calling URL is correct.')
  },
  finally: [corsify, logger],
})

// 添加基础路由
router
  .all('*', (request) => {
    // 处理预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': '*',
          'Access-Control-Allow-Headers': '*',
        },
      })
    }
  })
  .get('/', () => json({ message: 'API 服务运行中~' }))
  .get('/ping', () => json({ message: 'pong' }))
  .get(config.API_PREFIX + '/v1/models', () =>
    json({
      object: 'list',
      data: [
        { id: 'gpt-4o-mini', object: 'model', owned_by: 'ddg' },
        { id: 'claude-3-haiku', object: 'model', owned_by: 'ddg' },
        { id: 'llama-3.1-70b', object: 'model', owned_by: 'ddg' },
        { id: 'mixtral-8x7b', object: 'model', owned_by: 'ddg' },
      ],
    })
  )
  .post(config.API_PREFIX + '/v1/chat/completions', (req) => handleCompletion(req))

// 为 Vercel 环境导出路由处理函数
export default process.env.VERCEL ? router.fetch : undefined

// 本地开发环境启动服务器
if (!process.env.VERCEL) {
  (async () => {
    //For Cloudflare Workers
    if (typeof addEventListener === 'function') return
    // For Nodejs
    const ittyServer = createServerAdapter(router.fetch)
    console.log(`Listening on http://localhost:${config.PORT}`)
    const httpServer = createServer(ittyServer)
    httpServer.listen(config.PORT)
  })()
}