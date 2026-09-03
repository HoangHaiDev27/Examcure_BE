# Thiết lập backend AI

## Kiến trúc

- Supabase Auth và PostgreSQL là nguồn dữ liệu chính cho tài khoản, môn học,
  tài liệu, slide, câu hỏi, đề thi, trạng thái xử lý và audit log.
- Supabase Storage giữ PowerPoint gốc, PDF xem trước và ảnh từng slide.
- MongoDB Atlas chỉ giữ chunk văn bản và embedding dẫn xuất. Dữ liệu này có thể
  được tạo lại từ file và metadata trong Supabase.
- OpenAI tạo embedding và sinh câu hỏi JSON có cấu trúc.
- Worker Node chạy riêng với web API để dùng LibreOffice và Poppler.

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

Migration tạo schema, RLS, private Storage buckets, RPC nhận job và RPC lưu đề
theo giao dịch. Service-role key chỉ được dùng trong API/worker backend.

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

## 4. Công cụ chuyển PowerPoint

Máy chạy worker cần:

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

## 5. Chạy local

Mở hai terminal tại repo backend:

```powershell
npm run dev
```

```powershell
npm run worker:materials
```

Chạy một vòng nhận job rồi thoát:

```powershell
npm run worker:materials:once
```

UI chạy ở repo riêng và chỉ cần các biến public:

```text
NEXT_PUBLIC_API_URL=http://localhost:5010/api/v1
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
```

Luồng `/admin`: tạo môn học, upload PowerPoint bằng signed URL, worker chuyển
slide và ghi vector, admin yêu cầu AI tạo câu hỏi nháp, duyệt câu hỏi, rồi tạo
hoặc xuất bản đề thi.

## 6. Kiểm tra trước khi triển khai hạ tầng

```powershell
npm run typecheck
npm test
npm run test:materials
npm run build
```

Sau khi có Supabase/MongoDB và bộ chuyển đổi thật, cần chạy E2E với một `.pptx`:
kiểm tra PDF/ảnh trong Storage, số slide trong PostgreSQL, chunk trong MongoDB,
citation của câu hỏi và quyền truy cập student/admin.

## 7. Deploy API lên Render

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
Build Command: npm ci && npm run build
Start Command: npm run start
Health Check Path: /health
```

File `render.yaml` dùng `generateValue: true` cho JWT và `sync: false` cho các
secret. Đối với service Render đã tồn tại, vẫn phải nhập secret trực tiếp trong
Dashboard trước khi redeploy.
