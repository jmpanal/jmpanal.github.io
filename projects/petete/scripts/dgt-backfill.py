#!/usr/bin/env python3
"""Queue a resumable DGT archive import using administrator credentials prompted securely."""
import argparse, datetime, getpass, http.cookiejar, json, urllib.parse, urllib.request

def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--url',required=True);p.add_argument('--email',required=True);p.add_argument('--from-date',default='1997-01-01');p.add_argument('--to-date',default=datetime.date.today().isoformat());a=p.parse_args()
 root=a.url.rstrip('/');parsed=urllib.parse.urlsplit(root)
 if parsed.scheme!='https' and parsed.hostname not in ('localhost','127.0.0.1'):p.error('Use HTTPS for remote login.')
 opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
 def post(path,data):
  request=urllib.request.Request(root+'/api'+path,data=json.dumps(data).encode(),headers={'Content-Type':'application/json','Origin':parsed.scheme+'://'+parsed.netloc},method='POST')
  with opener.open(request,timeout=120) as response:return json.load(response)
 post('/auth/login',{'email':a.email,'password':getpass.getpass('Administrator password: ')})
 try:print(json.dumps(post('/admin/backfill',{'from':a.from_date,'to':a.to_date}),ensure_ascii=False,indent=2))
 finally:post('/auth/logout',{})
if __name__=='__main__':main()
