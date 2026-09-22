#pragma once

#include "liveContract.h"
#include <Windows.h>
#include <io.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <functional>
#include <mutex>
#include <thread>

namespace monky::screen_capture::live {

class FaultDiagnostics {
 public:
  FaultDiagnostics() {
    handler_ = AddVectoredExceptionHandler(0, Observe);
    Require(handler_ != nullptr, "Cannot register native fault diagnostics", "ERR_SCREEN_CAPTURE_DIAGNOSTICS");
  }
  ~FaultDiagnostics() {
    if (handler_ && !RemoveVectoredExceptionHandler(handler_)) {
      Write("ERR_SCREEN_CAPTURE_DIAGNOSTICS: fault observer removal failed\n");
    }
  }
  FaultDiagnostics(const FaultDiagnostics&) = delete;
  FaultDiagnostics& operator=(const FaultDiagnostics&) = delete;
  void Close() {
    if (!handler_) return;
    Require(RemoveVectoredExceptionHandler(handler_) != 0,
        "Cannot retire native fault diagnostics", "ERR_SCREEN_CAPTURE_DIAGNOSTICS");
    handler_ = nullptr;
  }
  static unsigned Observations() noexcept { return observations_.load(); }

 private:
  static void Write(const char* text) noexcept {
    const auto stream = GetStdHandle(STD_ERROR_HANDLE);
    DWORD written = 0;
    if (stream && stream != INVALID_HANDLE_VALUE)
      WriteFile(stream, text, static_cast<DWORD>(std::strlen(text)), &written, nullptr);
  }
  static LONG CALLBACK Observe(EXCEPTION_POINTERS* exception) noexcept {
    if (!exception || !exception->ExceptionRecord ||
        exception->ExceptionRecord->ExceptionCode != EXCEPTION_ACCESS_VIOLATION)
      return EXCEPTION_CONTINUE_SEARCH;
    const auto count = observations_.fetch_add(1) + 1;
    if (count > 8) {
      if (count == 9) Write("ERR_SCREEN_CAPTURE_DIAGNOSTICS: native fault observation limit reached\n");
      return EXCEPTION_CONTINUE_SEARCH;
    }
    const auto& record = *exception->ExceptionRecord;
    const auto instruction = reinterpret_cast<std::uintptr_t>(record.ExceptionAddress);
    HMODULE module = nullptr;
    char filename[MAX_PATH]{}, moduleFields[512]{};
    const char* name = nullptr;
    if (GetModuleHandleExA(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<const char*>(record.ExceptionAddress), &module)) {
      const auto length = GetModuleFileNameA(module, filename, MAX_PATH);
      if (length > 0 && length < MAX_PATH) {
        name = std::strrchr(filename, '\\');
        name = name ? name + 1 : filename;
        for (const char* p = name; *p; ++p)
          if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') ||
              *p == '.' || *p == '-' || *p == '_')) {
            name = nullptr;
            break;
          }
      }
    }
    const auto base = reinterpret_cast<std::uintptr_t>(module);
    if (name) std::snprintf(moduleFields, sizeof(moduleFields),
        "\"module\":\"%s\",\"moduleBase\":\"0x%llx\",\"moduleOffset\":\"0x%llx\"",
        name, static_cast<unsigned long long>(base), static_cast<unsigned long long>(instruction - base));
    else std::snprintf(moduleFields, sizeof(moduleFields),
        "\"module\":null,\"moduleBase\":null,\"moduleOffset\":null");
    char parameters[128]{};
    if (record.NumberParameters >= 2) std::snprintf(parameters, sizeof(parameters),
        "\"accessKind\":%llu,\"accessedAddress\":\"0x%llx\"",
        static_cast<unsigned long long>(record.ExceptionInformation[0]),
        static_cast<unsigned long long>(record.ExceptionInformation[1]));
    else std::snprintf(parameters, sizeof(parameters), "\"accessKind\":null,\"accessedAddress\":null");
    char diagnostic[1024]{};
    std::snprintf(diagnostic, sizeof(diagnostic),
        "{\"schemaVersion\":1,\"kind\":\"screen-capture-native-fault\",\"processId\":%lu,"
        "\"threadId\":%lu,\"firstChance\":true,\"exceptionHandled\":false,\"code\":\"0xc0000005\","
        "\"instruction\":\"0x%llx\",%s,%s}\n",
        GetCurrentProcessId(), GetCurrentThreadId(), static_cast<unsigned long long>(instruction),
        moduleFields, parameters);
    Write(diagnostic);
    return EXCEPTION_CONTINUE_SEARCH;
  }
  inline static std::atomic<unsigned> observations_{0};
  void* handler_ = nullptr;
};

class Output {
 public:
  explicit Output(std::string runId, std::function<void(const char*, const char*)> fail)
      : fail_(std::move(fail)), runId_(std::move(runId)) {
    media_ = reinterpret_cast<HANDLE>(_get_osfhandle(3));
    feedback_ = reinterpret_cast<HANDLE>(_get_osfhandle(4));
    Require(media_ && media_ != INVALID_HANDLE_VALUE && feedback_ && feedback_ != INVALID_HANDLE_VALUE &&
        GetFileType(media_) == FILE_TYPE_PIPE && GetFileType(feedback_) == FILE_TYPE_PIPE,
        "Live host requires two additional inherited parent pipes", "ERR_SCREEN_CAPTURE_PARENT");
    LARGE_INTEGER frequency{};
    Require(QueryPerformanceFrequency(&frequency) && frequency.QuadPart > 0, "Live QPC frequency unavailable");
    frequency_ = static_cast<std::uint64_t>(frequency.QuadPart);
    Notice("{\"kind\":\"hello\",\"runId\":" + JsonString(runId_) +
        ",\"processId\":" + std::to_string(GetCurrentProcessId()) +
        ",\"protocol\":1,\"timestampSemantics\":\"obs-system-pts\",\"transmitterReencode\":false}");
    worker_ = std::thread([this] { Run(); });
  }

  void Packet(const abi::EncoderPacket& packet, std::uint64_t observedQpc) {
    Require(packet.data && packet.size > 0 && packet.size <= kMaxPacketBytes &&
        packet.type == abi::EncoderType::Video, "Invalid live H264 packet", "ERR_SCREEN_CAPTURE_PACKET");
    std::unique_lock lock(mutex_);
    Require(!stopping_ && !failed_, "Live output is stopping", "ERR_SCREEN_CAPTURE_CLOSED");
    Require(packets_ < kMaxSafeInteger, "Capture frame counter exhausted", "ERR_SCREEN_CAPTURE_PACKET");
    Header header;
    header.kind = static_cast<std::uint32_t>(Kind::Packet);
    header.payloadBytes = static_cast<std::uint32_t>(packet.size);
    header.frameId = packets_ + 1; header.observedQpc = observedQpc; header.qpcFrequency = frequency_;
    header.timestampUs = clock_.Observe(packet); header.pts = packet.pts; header.dts = packet.dts;
    header.systemDtsUs = packet.sys_dts_usec; header.timebaseNumerator = packet.timebase_num;
    header.timebaseDenominator = packet.timebase_den; header.keyframe = packet.keyframe ? 1 : 0;
    header.settingsBitrateKbps = bitrate_.load();
    Enqueue(lock, header, {packet.data, packet.size});
    ++packets_;
  }

  void Notice(std::string_view text) {
    Require(ValidUtf8(text) && text.size() <= 16384, "Invalid live notice");
    std::unique_lock lock(mutex_);
    Header header; header.kind = static_cast<std::uint32_t>(Kind::Notice);
    header.payloadBytes = static_cast<std::uint32_t>(text.size());
    Enqueue(lock, header, {reinterpret_cast<const std::uint8_t*>(text.data()), text.size()});
  }

  std::vector<Feedback> Poll() {
    {
      std::lock_guard lock(mutex_);
      Require(!failed_, "Live output worker failed", "ERR_SCREEN_CAPTURE_PIPE");
      if (retained_) CheckBudget(0, 0, 1, oldestMs_, GetTickCount64());
    }
    DWORD available = 0;
    Require(PeekNamedPipe(feedback_, nullptr, 0, nullptr, &available, nullptr),
        "Live parent feedback pipe closed before STOP", "ERR_SCREEN_CAPTURE_PARENT");
    std::vector<Feedback> commands;
    if (!available) return commands;
    std::array<std::uint8_t, 512> bytes{};
    DWORD read = 0;
    Require(ReadFile(feedback_, bytes.data(), (std::min)(available, static_cast<DWORD>(bytes.size())), &read, nullptr) &&
        read > 0, "Cannot read live parent feedback", "ERR_SCREEN_CAPTURE_PARENT");
    for (DWORD i = 0; i < read; ++i) {
      const auto byte = bytes[i];
      if (byte == '\n') {
        const auto value = ParseFeedback(line_);
        Require(value.sequence == feedbackSequence_ + 1, "Live feedback sequence is not contiguous");
        feedbackSequence_ = value.sequence; line_.clear(); commands.push_back(value);
      } else {
        Require(byte >= 0x20 && byte <= 0x7e && line_.size() + 2 <= kMaxCommandLine,
            "Live feedback contains a control byte or exceeds80 bytes");
        line_.push_back(static_cast<char>(byte));
      }
    }
    return commands;
  }

  void Bitrate(std::uint32_t value) { bitrate_.store(value); }
  std::uint32_t Bitrate() const { return bitrate_.load(); }

  void Stop(std::optional<NativeFailure> failure = std::nullopt) {
    if (joined_) return;
    {
      std::lock_guard lock(mutex_);
      Require(line_.empty(), "Live STOP split a feedback command", "ERR_SCREEN_CAPTURE_PARENT");
      closureFailure_ = std::move(failure);
      stopping_ = true;
    }
    wake_.notify_all();
    const auto thread = static_cast<HANDLE>(worker_.native_handle());
    if (WaitForSingleObject(thread, 1500) != WAIT_OBJECT_0) {
      {
        std::lock_guard lock(mutex_); failed_ = true;
      }
      Fail("ERR_SCREEN_CAPTURE_BACKPRESSURE", "Live worker did not retire within1500ms");
      CancelSynchronousIo(thread);
      wake_.notify_all();
      Require(WaitForSingleObject(thread, 1500) == WAIT_OBJECT_0,
          "Live worker still owns its pipe/copies", "ERR_SCREEN_CAPTURE_RETIREMENT");
    }
    worker_.join(); joined_ = true;
    Require(!failed_ && retained_ == 0 && queue_.empty(), "Live output did not drain cleanly", "ERR_SCREEN_CAPTURE_RETIREMENT");
  }

 private:
  struct Item { Header header; std::vector<std::uint8_t> bytes; std::uint64_t atMs = 0; };

  void Fail(const char* code, const char* message) noexcept {
    try { fail_(code, message); }
    catch (...) { OutputDebugStringA("Monky live failure observer threw\n"); }
  }
  void Enqueue(std::unique_lock<std::mutex>& lock, Header header, std::span<const std::uint8_t> bytes) {
    const auto total = bytes.size() + sizeof(Header);
    Require(total <= kQueueBytes, "Live packet exceeds its copy budget", "ERR_SCREEN_CAPTURE_QUEUE");
    const auto room = [&] { return retained_ < kQueueFrames && total <= kQueueBytes - retainedBytes_; };
    if (!room()) {
      const auto began = GetTickCount64();
      CheckBudget(0, 0, 1, oldestMs_, began);
      ++backpressureWaits_;
      const auto remaining = kQueueAgeMs - (began - oldestMs_);
      Require(wake_.wait_for(lock, std::chrono::milliseconds(remaining),
          [&] { return failed_ || stopping_ || room(); }),
          "Live copy credit did not return within its500ms age bound", "ERR_SCREEN_CAPTURE_BACKPRESSURE");
      maxBackpressureMs_ = (std::max)(maxBackpressureMs_, GetTickCount64() - began);
    }
    const auto now = GetTickCount64();
    Require(!stopping_ && !failed_, "Cannot enqueue after live output stop", "ERR_SCREEN_CAPTURE_CLOSED");
    CheckBudget(retained_, retainedBytes_, total, retained_ ? oldestMs_ : now, now);
    Require(nextSequence_ < kMaxSafeInteger, "Capture pipe sequence exhausted", "ERR_SCREEN_CAPTURE_PIPE");
    header.sequence = nextSequence_;
    queue_.push_back({header, {bytes.begin(), bytes.end()}, now});
    ++nextSequence_; ++retained_; retainedBytes_ += total;
    if (retained_ == 1) oldestMs_ = now;
    peakFrames_ = (std::max)(peakFrames_, retained_); peakBytes_ = (std::max)(peakBytes_, retainedBytes_);
    wake_.notify_all();
  }
  void Write(std::span<const std::uint8_t> bytes) {
    while (!bytes.empty()) {
      DWORD written = 0;
      const auto count = static_cast<DWORD>((std::min)(bytes.size(), std::size_t{65536}));
      Require(WriteFile(media_, bytes.data(), count, &written, nullptr) && written > 0 && written <= count,
          "Live parent pipe write failed", "ERR_SCREEN_CAPTURE_PIPE");
      bytes = bytes.subspan(written);
    }
  }
  void Write(const Header& header, std::span<const std::uint8_t> bytes) {
    Write({reinterpret_cast<const std::uint8_t*>(&header), sizeof(header)});
    Write(bytes);
  }
  void Run() noexcept {
    try {
      for (;;) {
        Item item;
        {
          std::unique_lock lock(mutex_);
          wake_.wait(lock, [this] { return stopping_ || failed_ || !queue_.empty(); });
          Require(!failed_, "Live worker cancelled", "ERR_SCREEN_CAPTURE_PIPE");
          if (queue_.empty() && stopping_) break;
          item = std::move(queue_.front()); queue_.pop_front();
          CheckBudget(0, 0, 1, item.atMs, GetTickCount64());
        }
        Write(item.header, item.bytes);
        {
          std::lock_guard lock(mutex_);
          --retained_; retainedBytes_ -= sizeof(Header) + item.bytes.size();
          if (!queue_.empty()) oldestMs_ = queue_.front().atMs;
          if (item.header.kind == static_cast<std::uint32_t>(Kind::Packet)) ++writtenPackets_;
        }
        wake_.notify_all();
      }
      const auto text = "{\"kind\":\"closed\",\"runId\":" + JsonString(runId_) +
          ",\"packets\":" + std::to_string(packets_) + ",\"writtenPackets\":" + std::to_string(writtenPackets_) +
          ",\"peakFrames\":" + std::to_string(peakFrames_) + ",\"peakBytes\":" + std::to_string(peakBytes_) +
          ",\"backpressureWaits\":" + std::to_string(backpressureWaits_) +
          ",\"maxBackpressureMs\":" + std::to_string(maxBackpressureMs_) +
          ",\"retainedFrames\":0,\"retainedBytes\":0,\"workerDrained\":true,\"failure\":" +
          (closureFailure_ ? "{\"code\":" + JsonString(closureFailure_->code) +
              ",\"message\":" + JsonString(closureFailure_->message) + "}" : "null") + "}";
      Header header; header.kind = static_cast<std::uint32_t>(Kind::Closed);
      header.sequence = nextSequence_++; header.payloadBytes = static_cast<std::uint32_t>(text.size());
      Write(header, {reinterpret_cast<const std::uint8_t*>(text.data()), text.size()});
    } catch (const ContractError& error) {
      { std::lock_guard lock(mutex_); failed_ = true; }
      Fail(error.code.c_str(), error.what());
    } catch (const std::exception& error) {
      { std::lock_guard lock(mutex_); failed_ = true; }
      Fail("ERR_SCREEN_CAPTURE_WORKER", error.what());
    } catch (...) {
      { std::lock_guard lock(mutex_); failed_ = true; }
      Fail("ERR_SCREEN_CAPTURE_WORKER", "Unknown live writer exception");
    }
    wake_.notify_all();
  }

  std::function<void(const char*, const char*)> fail_;
  const std::string runId_;
  HANDLE media_ = nullptr, feedback_ = nullptr;
  std::uint64_t frequency_ = 0, nextSequence_ = 1, feedbackSequence_ = 0;
  std::uint64_t packets_ = 0, writtenPackets_ = 0, oldestMs_ = 0;
  std::uint64_t backpressureWaits_ = 0, maxBackpressureMs_ = 0;
  std::size_t retained_ = 0, retainedBytes_ = 0, peakFrames_ = 0, peakBytes_ = 0;
  std::atomic<std::uint32_t> bitrate_{20000};
  std::optional<NativeFailure> closureFailure_;
  bool stopping_ = false, failed_ = false, joined_ = false;
  std::string line_;
  PacketClock clock_;
  std::mutex mutex_;
  std::condition_variable wake_;
  std::deque<Item> queue_;
  std::thread worker_;
};

}  // namespace monky::screen_capture::live
