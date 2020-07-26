const net = require('net')


class Request {
  constructor(options) {
    this.method = options.method || 'GET'
    this.host = options.host
    this.port = options.port || 80
    this.path = options.path || '/'
    this.body = options.body || {}
    this.headers = options.headers || {}

    if(!this.headers['Content-Type']) {
      this.headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
    // 请求体转换
    if(this.headers['Content-Type'] === 'application/json') {
      this.bodyText = JSON.stringify(this.body)
    } else if (this.headers['Content-Type'] === 'application/x-www-form-urlencoded') {
      this.bodyText = Object.keys(this.body).map(key => `${key}=${encodeURIComponent(this.body[key])}`).join('&')
    }
    // 请求头中配置请求体的长度，用于判断请求传的内容是否都传递完成
    this.headers['Content-Length'] = this.bodyText.length
  }

  send(connection) {
    return new Promise((resolve, reject) => {
      
      const parser = new ResponseParser

      // connection 存在则写入收集到的信息
      if(connection) {
        connection.write(this.toString())
      } else {
        // 不存在则先创建 connection TCP 连接, 然后再写入
        connection = net.createConnection({
          host: this.host,
          port: this.port
        }, () => {
          connection.write(this.toString())
        })
      }
      // 监听 connection 的 data
      connection.on('data', data => {
        // console.log(data.toString())
        // 进行解析
        parser.receive(data.toString())
        // 解析完成
        if(parser.isFinished) {
          // 返回解析内容0
          resolve(parser.response)
          // 关闭连接
          connection.end()
        }
      })
      // 错误处理，断开连接
      connection.on('error', err => {
        reject(err)
        connection.end()
      })
      // resolve("")
    })
  }
  // 将请求头及请求体转换成 HTTP 所需要的格式
  toString() {
    return `${this.method} ${this.path} HTTP/1.1\r
${Object.keys(this.headers).map(key => `${key}: ${this.headers[key]}`).join('\r\n')}\r
\r
${this.bodyText}`
  }
}

// 逐步接收 response 的文本然后进行分析
class ResponseParser {
  constructor() {
    this.WAITING_STATUS_LINE = 0
    this.WAITING_STATUS_LINE_END = 1

    this.WAITING_HEADER_NAME = 2
    this.WAITING_HEADER_SPACE = 3
    this.WAITING_HEADER_VALUE = 4
    this.WAITING_HEADER_LINE_END = 5
    
    this.WAITING_HEADER_BLOCK_END = 6
    this.WAITING_BODY = 7

    // 存储解析过程中的结果
    this.current = this.WAITING_STATUS_LINE
    this.statusLine = ''
    this.headers = {}
    this.headerName = ''
    this.headerValue = ''
    this.bodyParser = null
  }
  // 获取完成状态
  get isFinished () {
    return this.bodyParser && this.bodyParser.isFinished
  }
  // 给出请求返回
  get response () {
    this.statusLine.match(/HTTP\/1.1 ([0-9]+) ([\s\S]+)/)
    return {
      statusCode: RegExp.$1,
      statusText: RegExp.$2,
      headers: this.headers,
      body: this.bodyParser.content.join('')
    }
  }
  // 接受字符串逐个进行处理
  receive(string) {
    for(let i = 0; i< string.length; i++) {
      // "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nDate: Sun, 26 Jul 2020 04:31:19 GMT\r\nConnection: keep-alive\r\nTransfer-Encoding: chunked\r\n\r\nd\r\n Hello World\n\r\n0\r\n\r\n"
      this.receiveChar(string.charAt(i))
    }
  }
  receiveChar(char) {
    // HTTP 状态
    if (this.current === this.WAITING_STATUS_LINE) {
      // 如果遇到 \r 则进入下一状态
      if (char === '\r') {
        this.current = this.WAITING_STATUS_LINE_END        
      } else {
        this.statusLine += char
      }
    //　进入到请求头
    } else if (this.current === this.WAITING_STATUS_LINE_END) {
      if (char === '\n') {
        this.current = this.WAITING_HEADER_NAME
      }
    }　else if (this.current === this.WAITING_HEADER_NAME) {
      if (char === ':') {
        this.current = this.WAITING_HEADER_SPACE
      } else if (char === '\r') {
        // 如果仍然等来了一个 '\r' 则表示请求头结束了
        this.current = this.WAITING_HEADER_BLOCK_END
        // 'Transfer-Encoding' 的值有很多，node 默认 chunked
        if (this.headers['Transfer-Encoding'] === 'chunked') {
          this.bodyParser = new TrunkedBodyParser()
        }
      } else {
        this.headerName += char
      }
    } else if (this.current === this.WAITING_HEADER_SPACE) {
      if (char === ' ') {
        this.current = this.WAITING_HEADER_VALUE
      }
    } else if (this.current === this.WAITING_HEADER_VALUE) {
      if (char === '\r') {
        this.current = this.WAITING_HEADER_LINE_END
        this.headers[this.headerName] = this.headerValue
        this.headerName = ''
        this.headerValue = ''
      } else {
        this.headerValue += char
      }
    } else if (this.current === this.WAITING_HEADER_LINE_END) {
      if (char === '\n') {
        // 如果在 WAITING_HEADER_NAME 中等来了 '\r' 则表示请求头结束
        this.current = this.WAITING_HEADER_NAME
      }
    } else if (this.current === this.WAITING_HEADER_BLOCK_END) {
      if (char === '\n') {
        this.current = this.WAITING_BODY
      }
    } else if (this.current === this.WAITING_BODY) {
      // console.log(char)
      this.bodyParser.receiveChar(char)
    }
  }
}

class TrunkedBodyParser {
  constructor() {
    this.WAITING_LENGTH = 0
    this.WAITING_LENGTH_LINE_END = 1

    this.READING_TRUNK = 2
    this.WAITING_NEW_LINE = 3
    this.WAITING_NEW_LINE_END = 4
    this.length = 0
    this.content = []
    this.isFinished = false
    this.current = this.WAITING_LENGTH
  }

  receiveChar(char) {
    if (this.current === this.WAITING_LENGTH) {
      if (char === '\r') {
        if (this.length === 0) {
          this.isFinished = true
        }
        this.current = this.WAITING_LENGTH_LINE_END
      } else {
        // 首位是一个 16 进制的标识，body的长度
        this.length *= 16
        this.length += parseInt(char, 16)
      }
    } else if (this.current === this.WAITING_LENGTH_LINE_END) {
      // 首位文本长度获取完成
      if (char === '\n') {
        this.current = this.READING_TRUNK
      }
    } else if (this.current === this.READING_TRUNK) {
      this.content.push(char)
      this.length --
      if (this.length === 0) {
        this.current = this.WAITING_NEW_LINE
      }
      // console.log(this.content.join('')) 
    } else if (this.current === this.WAITING_NEW_LINE) {
      if (char === '\r') {
        this.current = this.WAITING_NEW_LINE_END
      }
    } else if (this.current === this.WAITING_NEW_LINE_END) {
      if (char === '\n') {
        this.current = this.WAITING_LENGTH
      }
    }
  }
}

      // "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nDate: Sun, 26 Jul 2020 04:31:19 GMT\r\nConnection: keep-alive\r\nTransfer-Encoding: chunked\r\n\r\nd\r\n Hello World\n\r\n0\r\n\r\n"
void async function () {
  let request = new Request({
    method: 'POST', // HTTP
    host: '127.0.0.1', // IP
    port: '8088', // TCP
    path: '/', // HTTP
    headers: { // HTTP
      ["X-Foo2"]: "customed"
    },
    body: {
      name: 'jerry'
    }
  })
  let response = await request.send()
  console.log(response)
}()