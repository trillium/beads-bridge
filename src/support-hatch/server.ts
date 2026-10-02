import { createServer } from 'node:http'
import { createSupportHatchApp } from './mcp'

const port = Number(process.env.SUPPORT_HATCH_PORT || 31339)
const token = process.env.SUPPORT_HATCH_TOKEN || ''
const app = createSupportHatchApp(token)
const server = createServer(app)
server.listen(port, '0.0.0.0', () => {
  console.log(`independent support hatch listening on :${port}`)
})
