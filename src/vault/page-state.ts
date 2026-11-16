/** Heuristic challenge detection: conservative stop, never CAPTCHA solving or bypass. */
export function pageState(page:{url:string;title:string;text:string;challengeVisible?:boolean}):'page'|'captcha_required'|'search_no_results'|'browser_access_blocked'{
 const text=(page.title+'\n'+page.text).normalize('NFKC').toLowerCase();let url:URL;try{url=new URL(page.url);}catch{return 'browser_access_blocked';}
 if(page.challengeVisible===true||((url.hostname==='google.com'||url.hostname.endsWith('.google.com'))&&url.pathname.startsWith('/sorry/'))||/^(?:captcha|security check|verify you are human|人机验证|人機驗證|보안 확인)$/i.test(page.title.trim())||(/unusual traffic from your computer network|our systems have detected unusual traffic|로봇이 아닙니다|자동 입력 방지|비정상적인 트래픽|私はロボットではありません|通常と異なるトラフィック|我不是机器人|我不是機器人|请完成安全验证|verify (?:that )?you are (?:a )?human|confirm you are not a robot/i.test(text)&&text.length<5000))return 'captcha_required';
 if(url.protocol==='chrome-error:'||/^(access denied|403 forbidden|too many requests)$/i.test(page.title.trim()))return 'browser_access_blocked';
 const search=(url.hostname==='www.google.com'&&url.pathname==='/search')||(url.hostname==='www.bing.com'&&url.pathname==='/search');
 if(search&&/did not match any documents|no results found|검색결과가 없습니다|검색 결과가 없습니다|일치하는 검색결과가 없습니다|一致する情報は見つかりませんでした|検索結果がありません|没有找到|找不到符合|沒有找到/.test(text))return 'search_no_results';
 return 'page';
}
export const captchaMessage='CAPTCHA 확인이 필요해 자동 탐색을 중단했습니다. 검색 결과나 정보 부재로 판단하지 않았습니다. 일반 브라우저에서 직접 확인하거나 공식 문서 URL 또는 문서 내용을 제공해 새 작업을 시작하세요. 현재 VM 세션의 CAPTCHA를 대신 풀거나 자동 재시도하지 않습니다.';
export function webFailureMessage(code:string){return code==='captcha_required'?captchaMessage:code==='search_no_results'?'이 검색어에 대해 검색엔진이 결과 없음을 표시했습니다. 정보 자체가 없다는 뜻은 아닙니다. 공식 문서 URL로 직접 확인할 수 있습니다.':'웹 조회가 차단되었거나 실패했습니다. 정보가 없다는 뜻은 아닙니다. 사용자가 제공한 공식 문서 URL 또는 문서 내용으로 확인하세요.';}
