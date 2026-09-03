# Thiết lập backend AI

## Kiến trúc

- Supabase Auth và PostgreSQL là nguồn dữ liệu chính cho tài khoản, môn học,
  tài liệu, slide, câu hỏi, đề thi, trạng thái xử lý và audit log.
- Supabase Storage giữ PowerPoint gốc. Ở chế độ miễn phí không worker, hệ thống
  chỉ trích text/note trong `.pptx`; không tạo PDF xem trước hoặc ảnh slide.
- MongoDB Atlas chỉ giữ chunk văn bản và embedding dẫn xuất. Dữ liệu này có thể
  được tạo lại từ file và metadata trong Supabase.
- OpenAI tạo embedding và sinh câu hỏi JSON có cấu trúc.
- Render Web API xử lý đồng bộ text/note của `.pptx`, tạo embedding và ghi
  MongoDB ngay sau khi admin upload. Worker Docker chỉ là lựa chọn bổ sung nếu
  sau này cần PDF/ảnh slide hoặc file `.ppt` cũ.

## 1. Cấu hình môi trường

Sao chép `.env.example` thành `.env`, rồi điền giá trị thật. Không commit `.env`,
service-role key hoặc OpenAI key.

Các biến chính:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
MONGODB_URI
OPENAI_API_KEY
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_QUESTION_MODEL=gpt-5.6-luna
```

`ADMIN_BOOTSTRAP_TOKEN` là tùy chọn dùng một lần để mở trang `/admin` trước khi
có tài khoản admin. Đặt chuỗi ngẫu nhiên dài, tạo/cấp quyền admin, sau đó xóa
biến này khỏi production.

Embedding mặc định có 1536 chiều. Nếu đổi model hoặc số chiều, cập nhật
`MONGODB_VECTOR_DIMENSIONS`, tạo lại Vector Search index và lập chỉ mục lại toàn
bộ tài liệu.

## 2. Khởi tạo Supabase

Chạy migration bằng Supabase CLI hoặc SQL Editor:

```text
supabase/migrations/202608310001_examcure_ai.sql
```

Migration tạo schema, RLS, private Storage buckets, RPC nhận job (chỉ dùng cho
worker tùy chọn) và RPC lưu đề theo giao dịch. Service-role key chỉ được dùng
trong backend.

Sau khi đăng ký tài khoản quản trị, cấp vai trò một lần trong SQL Editor:

```sql
update public.profiles
set role = 'admin', updated_at = now()
where id = (select id from auth.users where email = 'admin@example.com');
```

Trong Supabase Authentication, cấu hình Site URL/Redirect URLs theo domain UI.
Nếu dùng Google, bật Google provider. Nếu UI xác thực bằng OTP, email template
đăng ký và khôi phục cần hiển thị `{{ .Token }}`.

## 3. Khởi tạo MongoDB Vector Search

MongoDB phải hỗ trợ Atlas Vector Search. Sau khi điền `.env`, chạy:

```powershell
npm run setup:mongodb-vector
```

Lệnh tạo unique index `chunk_id`, index lọc phiên bản và Vector Search index có
tên từ `MONGODB_VECTOR_INDEX`.

## 4. Chế độ miễn phí: xử lý trực tiếp trong API Render

Không cần Background Worker và không cần cài LibreOffice/Poppler. Admin chỉ
upload `.pptx` tối đa **20 MB**. Sau khi file được đưa vào Supabase Storage,
API Render sẽ đồng bộ:

1. đọc text và speaker notes từ từng slide;
2. lưu text vào bảng `slides` của Supabase (không có `image_path`);
3. tạo embedding qua OpenAI và lưu chunk vào MongoDB Atlas;
4. đưa `material_versions.status` về `ready` để có thể tạo câu hỏi AI.

Giữ request upload mở đến khi hoàn tất. Vì vậy file lớn/nhiều text sẽ chậm hơn
và vẫn phát sinh chi phí OpenAI embedding. Chế độ này không hỗ trợ `.ppt`,
không dựng PDF, không sinh ảnh slide và không trích được text nằm trong ảnh.

Sau khi tài liệu `ready`, sinh viên đã đăng nhập có thể xem text/note từng slide
trực tiếp tại trang môn học và tải file `.pptx` gốc. API chỉ tạo link tải private
có hiệu lực 60 giây; không đưa `SUPABASE_SERVICE_ROLE_KEY` hoặc link Storage cố
định ra frontend.

## 5. Worker chuyển PowerPoint (tùy chọn, có phí Render)

Chỉ dùng phần này khi cần chuyển `.ppt/.pptx` thành PDF và ảnh slide. Máy chạy
worker cần:

- LibreOffice (`soffice`) để chuyển `.ppt/.pptx` thành PDF.
- Poppler `pdftoppm` để render ảnh PNG.
- Poppler `pdftotext` để trích text dự phòng, nhất là `.ppt` cũ.

Có thể đặt đường dẫn tuyệt đối trong `LIBREOFFICE_BIN`, `PDFTOPPM_BIN` và
`PDFTOTEXT_BIN`. Kiểm tra trên Windows:

```powershell
where.exe soffice
where.exe pdftoppm
where.exe pdftotext
```

## 6. Chạy local

Với chế độ không worker, chỉ mở một terminal tại repo backend:

```powershell
npm run dev
```

```powershell
```

UI chạy ở repo riêng và chỉ cần các biến public:

```text
NEXT_PUBLIC_API_URL=http://localhost:5010/api/v1
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
```

Luồng `/admin`: tạo môn học, upload `.pptx` bằng signed URL, API trích text/note
và ghi vector, admin yêu cầu AI tạo câu hỏi nháp, duyệt câu hỏi, rồi tạo hoặc
xuất bản đề thi.

## 7. Kiểm tra trước khi triển khai hạ tầng

```powershell
npm run typecheck
npm test
npm run test:materials
npm run build
```

Sau khi có Supabase/MongoDB/OpenAI thật, cần chạy E2E với một `.pptx`: kiểm tra
số slide trong PostgreSQL, chunk trong MongoDB, citation của câu hỏi và quyền
truy cập student/admin. PDF/ảnh chỉ xuất hiện khi có worker tùy chọn.

## 8. Deploy API lên Render

Backend Express chạy trên Render Web Service; Supabase vẫn là Auth, PostgreSQL
và Storage. Với service tạo thủ công, thêm các biến sau trong **Environment**:

```text
NODE_ENV=production
ENABLE_LEGACY_AUTH=false
DEV_EXPOSE_OTP=false
CORS_ORIGIN=https://TEN-FRONTEND-CUA-BAN
SUPABASE_URL=https://YOUR_PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
MONGODB_URI=...
OPENAI_API_KEY=...
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_QUESTION_MODEL=gpt-5.6-luna
MONGODB_VECTOR_DIMENSIONS=1536
```

`JWT_SECRET` không được backend Supabase-only sử dụng, nhưng Blueprint sẽ sinh
một giá trị bền vững để có thể bật lại auth cũ sau này. Nếu `ENABLE_LEGACY_AUTH`
được đổi thành `true`, production bắt buộc có `JWT_SECRET` tối thiểu 32 ký tự và
`SMTP_HOST`.

Thiết lập Render:

```text
Build Command: npm ci --include=dev && npm run build
Start Command: npm run start
Health Check Path: /health
```

File `render.yaml` dùng `generateValue: true` cho JWT và `sync: false` cho các
secret. Đối với service Render đã tồn tại, vẫn phải nhập secret trực tiếp trong
Dashboard trước khi redeploy.

## 9. Deploy PowerPoint worker bằng Docker trên Render (tùy chọn)

Không tạo service này cho chế độ miễn phí ở mục 4. API đã xử lý `.pptx` text
trực tiếp. Chỉ tạo khi cần PDF/ảnh slide hoặc file `.ppt` cũ.
`Dockerfile.worker` cài `libreoffice-impress`, `pdftoppm` và `pdftotext`, rồi
chạy `scripts/process-materials.mjs --watch` để nhận job từ `processing_jobs`.

Trong Render Dashboard:

1. Chọn **New → Background Worker** và kết nối cùng repo backend.
2. Chọn runtime **Docker** và Dockerfile path `./Dockerfile.worker`.
3. Chọn compute plan tối thiểu `0.5c-512mb`.
4. Sao chép các Environment Variables sau từ Web Service API:

```text
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
MONGODB_URI
OPENAI_API_KEY
OPENAI_EMBEDDING_MODEL=text-embedding-3-small
OPENAI_QUESTION_MODEL=gpt-5.6-luna
MONGODB_DATABASE=examcure
MONGODB_VECTOR_COLLECTION=material_chunks
MONGODB_VECTOR_INDEX=material_vector_index
MONGODB_VECTOR_DIMENSIONS=1536
MATERIAL_WORKER_NAME=render-material-worker
```

Background Worker của Render không có free tier; chỉ tạo service khi đã chấp
nhận chi phí compute. Sau khi deploy, log worker phải tiếp tục chạy mà không
thoát; khi có PowerPoint được upload, log sẽ ghi số slide và chunk đã xử lý.
