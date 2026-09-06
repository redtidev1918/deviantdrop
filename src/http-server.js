import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export function createHttpServer(handler, env) {
  return createServer(async (req,res)=>{
    try {
      const chunks=[]; let size=0;
      for await(const chunk of req) {
        size+=chunk.length;
        if(size>65536){res.writeHead(413).end('Payload too large');return;}
        chunks.push(chunk);
      }
      const request=new Request(new URL(req.url,env.PUBLIC_BASE_URL || 'http://localhost'),{
        method:req.method,headers:new Headers(req.headers),
        body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks),
      });
      const response=await handler(request,env);
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body) await pipeline(Readable.fromWeb(response.body),res); else res.end();
    }catch{
      console.error('HTTP request failed');
      if(!res.headersSent)res.writeHead(500);
      res.end('Internal error');
    }
  });
}
