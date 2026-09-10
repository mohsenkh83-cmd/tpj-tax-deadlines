"""Notify the repository owner about new pending reviews through GitHub Issues.
No SMTP/password is required; delivery follows the owner's GitHub settings.
"""
import json
import os
import re
from pathlib import Path
import requests

REPOSITORY = 'mohsenkh83-cmd/tpj-tax-deadlines'
TITLE = 'TPJ — خبرهای در انتظار تأیید'
PANEL = 'https://mohsenkh83-cmd.github.io/tpj-tax-deadlines/admin.html'
MARKER = '<!-- tpj-review-notified:'

def run():
    if os.environ.get('GITHUB_REPOSITORY') != REPOSITORY:
        raise RuntimeError('This notifier is restricted to the TPJ repository.')
    session = requests.Session()
    session.headers.update({'Authorization': 'Bearer '+os.environ['GH_TOKEN'], 'Accept': 'application/vnd.github+json'})
    base = 'https://api.github.com/repos/'+REPOSITORY
    def api(path, method='GET', **kwargs):
        r = session.request(method, base+path, timeout=30, **kwargs)
        r.raise_for_status()
        return r.json()
    def pages(path):
        result=[]
        for page in range(1,100):
            rows=api(path+('&' if '?' in path else '?')+f'per_page=100&page={page}')
            result.extend(rows)
            if len(rows)<100:return result
        raise RuntimeError('Pagination limit reached; refusing duplicate notifications.')
    # Fetch current committed state, not a stale runner snapshot.
    import base64
    remote=api('/contents/monitor-state.json?ref=main')
    state=json.loads(base64.b64decode(remote['content']))
    pending={k:v for k,v in state.get('review',{}).items() if v.get('status')=='pending'}
    issues=[i for i in pages('/issues?state=all&creator=github-actions%5Bbot%5D') if i.get('title')==TITLE and 'pull_request' not in i]
    notified=set()
    for issue in issues:
        texts=[issue.get('body') or '']+[c.get('body') or '' for c in pages(f"/issues/{issue['number']}/comments") if c.get('user',{}).get('login')=='github-actions[bot]']
        for text in texts:
            for payload in re.findall(r'<!-- tpj-review-notified:(.*?) -->',text):
                notified.update(json.loads(payload))
    fresh=[k for k in pending if k not in notified]
    if not pending:
        for i in issues:
            if i['state']=='open':api(f"/issues/{i['number']}",'PATCH',json={'state':'closed'})
        print('No pending reviews.');return
    if not fresh:
        print('No unnotified pending reviews.');return
    owner=api('')['owner']['login']
    if owner!='mohsenkh83-cmd':raise RuntimeError('Unexpected repository owner')
    body=f'@{owner}\n\n{len(fresh)} خبر جدید منتظر بررسی شماست.\n\n[بازکردن پنل تأیید]({PANEL})\n\nتا تأیید شما خبر تازه منتشر نمی‌شود و موعد تقویم تغییر نمی‌کند.\n\n'+MARKER+json.dumps(fresh)+' -->'
    current=next((i for i in issues if i['state']=='open'),None)
    if current:
        api(f"/issues/{current['number']}/comments",'POST',json={'body':body})
    else:
        api('/issues','POST',json={'title':TITLE,'body':body,'assignees':[owner]})
    print(f'Notification created for {len(fresh)} pending items.')

if __name__=='__main__':run()
