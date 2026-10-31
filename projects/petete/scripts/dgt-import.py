#!/usr/bin/env python3
"""Import licensed or official-source JSONL with an administrator session. No secrets in argv."""
import argparse, getpass, http.cookiejar, json, pathlib, urllib.parse, urllib.request

def main():
 p=argparse.ArgumentParser(description=__doc__)
 p.add_argument('--url',required=True,help='App root, e.g. https://www.jmpanal.com/petete')
 p.add_argument('--email',required=True)
 p.add_argument('--file',required=True,type=pathlib.Path,help='JSONL, one full normalized document per line')
 p.add_argument('--permission-reference',help='CENDOJ written authorization or agreement reference')
 args=p.parse_args()
 root=args.url.rstrip('/')
 origin=urllib.parse.urlsplit(root)
 if origin.scheme!='https' and origin.hostname not in ('localhost','127.0.0.1'):p.error('Use HTTPS for remote logins.')
 jar=http.cookiejar.CookieJar();opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
 def post(path,payload):
  request=urllib.request.Request(root+'/api'+path,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Origin':origin.scheme+'://'+origin.netloc},method='POST')
  try:
   with opener.open(request,timeout=120) as response:return json.load(response)
  except urllib.error.HTTPError as error:
   raise SystemExit(f'HTTP {error.code}: '+error.read(4096).decode('utf-8','replace')) from None
 post('/auth/login',{'email':args.email,'password':getpass.getpass('Administrator password: ')})
 count=0
 try:
  with args.file.open(encoding='utf-8') as stream:
   for line_number,line in enumerate(stream,1):
    if not line.strip():continue
    try:document=json.loads(line)
    except json.JSONDecodeError as error:raise SystemExit(f'Line {line_number}: invalid JSON: {error}') from None
    payload={'documents':[document]}
    if document.get('source')=='cendoj':
     if not args.permission_reference:raise SystemExit('CENDOJ import requires --permission-reference and an existing written reuse authorization.')
     payload['permission']={'license':'authorized','permissionReference':args.permission_reference}
    result=post('/admin/import',payload);count+=1
    print(json.dumps({'line':line_number,'result':result},ensure_ascii=False))
 finally:
  post('/auth/logout',{})
 print(f'Processed {count} documents. AI enrichment runs separately; importing does not mean a full corpus is indexed.')
if __name__=='__main__':main()
