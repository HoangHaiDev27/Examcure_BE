# Chuyển toàn hệ thống khỏi Supabase

Code FE/BE/worker hiện không gọi Supabase. Auth và dữ liệu nằm trong ExamcureBe;
MongoDB lưu toàn bộ dữ liệu ứng dụng; S3, SMTP và Google là dịch vụ hỗ trợ. Các migration
cũ được giữ trong lịch sử Git, không áp dụng cho database mới.

Chưa chuyển dữ liệu hoặc triển khai trên hệ thống thật. Không xóa project cũ
trước khi kiểm tra bản import, file và các luồng đăng nhập trên hạ tầng mới.

## Chuẩn bị bản export

Export offline JSON từ database cũ và tải các file Storage về một thư mục riêng.
Tạo `manifest.json` có dạng:

```json
{
  "version": 1,
  "users": [],
  "profiles": [],
  "subjects": [],
  "materials": [],
  "material_versions": [],
  "slides": [],
  "generation_runs": [],
  "questions": [],
  "question_options": [],
  "question_sources": [],
  "exams": [],
  "exam_questions": [],
  "audit_logs": [],
  "files": [
    {
      "bucket": "material-originals",
      "path": "subject/material/version/lecture.pptx",
      "file": "objects/lecture.pptx",
      "contentType": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    }
  ]
}
```

Các array tương ứng các bảng public cũ, dùng nguyên tên cột snake_case.
`users` lấy từ `auth.users`: cần `id`, `email`, `encrypted_password`,
`email_confirmed_at`, `raw_user_meta_data`; kèm array `identities` của từng user
từ `auth.identities` nếu có Google. Identity cần `provider=google` và
`identity_data.sub` để giữ liên kết tài khoản Google. `profiles` giữ full_name,
school_id và role. Mọi user được tham chiếu bởi dữ liệu phải có trong export.

`files[].file` là đường dẫn tương đối bên trong thư mục chứa manifest. Export
đủ file gốc cho từng version, dung lượng phải khớp metadata (tối đa 20 MB).
Thêm các PDF/PNG nếu cần giữ preview. Paths ngoài thư mục export bị từ chối.
Bucket custom preview/slide cần chuẩn hóa sang `material-previews`/`slide-images`
trong manifest và object listing.

Importer giữ UUID tài khoản/nội dung và kiểm tra các tham chiếu. Password bcrypt cũ
được BE xác minh, user vẫn dùng mật khẩu cũ; không cần import refresh session.
Hash khác bcrypt/scrypt bị từ chối để chuẩn bị reset trước khi chuyển. Admin
import sẽ khóa bootstrap. Audit ID số cũ được lưu trong details và chuyển UUID.
Queue đang chạy không import; hoàn tất trước cutover hoặc enqueue lại tài liệu
cần xử lý trên BE mới. MongoDB vector có thể giữ nếu UUID/version không đổi,
hoặc tạo lại bằng pipeline của BE.

## Import và cutover

1. Dừng ghi trên hệ thống cũ trong cửa sổ cutover, export cuối cùng và backup.
2. Tạo MongoDB replica set/Atlas mới + bucket riêng tư, điền môi trường BE/FE và SMTP/Google.
3. Kiểm tra export trên database đích rỗng:

   ```sh
   npm run db:import -- ./private-export/manifest.json
   ```

   Mặc định chỉ kiểm tra cấu trúc, file và đích rỗng; có thể tạo collections/indexes đích,
   không insert dữ liệu/upload file. Không in password hash hoặc credentials.

4. Áp dụng sau khi bản kiểm tra hợp lệ:

   ```sh
   npm run db:import -- ./private-export/manifest.json --apply
   ```

   Documents import trong một transaction; lỗi không để lại documents một phần. File đã
   upload trước lỗi transaction có thể còn trên bucket, retry chỉ reuse bytes giống hệt,
   không ghi đè object khác. Import không ghi đè database đang có tài khoản/nội dung.

5. So sánh số lượng tài khoản/môn/tài liệu/câu hỏi/đề và kiểm tra file tải đúng bytes.
6. Chạy checklist auth/admin/pipeline trong `AI_BACKEND_SETUP.md` bằng dịch vụ thật.
7. Build/deploy FE/BE cùng nhau. Phiên Supabase cũ không dùng được; user đăng nhập lại.
8. Khi hệ thống mới ổn định và backup đầy đủ, mới ngừng tài nguyên cũ theo quyết định
   của người vận hành. Công cụ này không xóa hoặc thay đổi project/database nguồn.

Không đưa `private-export/`, password hash, JWT secret hay file `.env` vào Git.


MongoDB lưu đáp án/nguồn trong document câu hỏi, danh sách câu hỏi trong
document đề thi. Importer ghép các array cũ, giữ UUID và dùng boolean, array,
object BSON thay cho JSON string. OTP/session cũ không import; người dùng
đăng nhập lại sau khi chuyển. MongoDB và bucket đích cần được backup.
