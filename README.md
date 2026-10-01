# Text Level Changer (웹사이트 버전)

영어 지문 → 중3 진단 평가 → 채점 → 중1/고2 맞춤 학습 자료.
생성은 경희대 ChatKHU API Gateway(`claude-sonnet-5-5`)로 합니다.

## 구조

```
브라우저 (public/index.html)
   ↓ POST /api/generate  { prompt }
중계 서버 (api/generate.js)   ← API 키는 여기 환경 변수에만 있음
   ↓ POST {BASE_URL}/chat/completions/   Authorization: Bearer <키>
ChatKHU API Gateway
```

## 배포 (Vercel, 무료)

1. 이 폴더를 GitHub 저장소로 올립니다. (`.env`는 올라가지 않게 `.gitignore`에 들어 있어요.)
2. vercel.com 에 GitHub로 로그인 → **Add New → Project** → 방금 올린 저장소 선택 → Deploy.
3. 프로젝트 **Settings → Environment Variables**에 아래를 추가합니다.
   - `CHATKHU_API_KEY` = ChatKHU에서 만든 API 키
   - `ACCESS_CODE` = 팀원에게만 알려 줄 접속 코드 (권장)
4. **Deployments → 맨 위 배포 → Redeploy**로 다시 배포하면 환경 변수가 적용됩니다.
5. 발급된 `https://....vercel.app` 주소를 열고, 처음 생성 버튼을 누를 때 접속 코드를 입력합니다.

## 로컬에서 시험하기

```bash
npm i -g vercel
cp .env.example .env     # CHATKHU_API_KEY, ACCESS_CODE 채우기
vercel dev
```

## 알아둘 점

- 사용량은 키를 만든 ChatKHU 계정의 크레딧에서 차감됩니다. `ACCESS_CODE`와 `HOURLY_LIMIT_PER_IP`(기본 시간당 30회)로 막아 두세요.
- 키가 노출됐다고 의심되면 ChatKHU API Gateway 화면에서 키를 삭제하고 새로 만든 뒤 Vercel 환경 변수를 바꿉니다.
- 학생 기록(닉네임별 이력)은 아직 이 버전에 없습니다.
