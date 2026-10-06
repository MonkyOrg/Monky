#include <node_api.h>
#include <IOSurface/IOSurface.h>
#include <CoreFoundation/CoreFoundation.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>
#include <bsm/libbsm.h>
#include <unistd.h>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <new>

namespace {
constexpr napi_type_tag kLeaseTag{0x6d6f6e6b79737572ULL, 0x666163656c656173ULL};
constexpr napi_type_tag kChannelTag{0x6d6f6e6b79737572ULL, 0x666163656368616eULL};
constexpr mach_msg_id_t kMessageId = 0x4d4b5953;
struct Lease { IOSurfaceRef surface; };
struct Channel {
  mach_port_t port = MACH_PORT_NULL;
  pid_t peer = 0;
  bool receiver = false;
  char name[128]{};
};
struct SurfaceMessage {
  mach_msg_header_t header;
  mach_msg_body_t body;
  mach_msg_port_descriptor_t surface;
  uint64_t frame_id;
};
napi_value Fail(napi_env env, const char* message) {
  napi_throw_error(env, "ERR_RTC_IOSURFACE", message);
  return nullptr;
}
bool Number(napi_env env, napi_value value, double maximum, double* result) {
  return napi_get_value_double(env, value, result) == napi_ok &&
    std::isfinite(*result) && *result >= 1 && *result <= maximum && std::floor(*result) == *result;
}
void Retire(Lease* lease) {
  if (!lease->surface) return;
  IOSurfaceDecrementUseCount(lease->surface);
  CFRelease(lease->surface);
  lease->surface = nullptr;
}
void FinalizeLease(napi_env, void* data, void*) {
  auto* lease = static_cast<Lease*>(data);
  Retire(lease);
  delete lease;
}
napi_value CloseLease(napi_env env, napi_callback_info info) {
  napi_value self, result;
  size_t count = 0;
  bool tagged = false;
  Lease* lease = nullptr;
  if (napi_get_cb_info(env, info, &count, nullptr, &self, nullptr) != napi_ok ||
      napi_check_object_type_tag(env, self, &kLeaseTag, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, self, reinterpret_cast<void**>(&lease)) != napi_ok || !lease)
    return Fail(env, "Invalid IOSurface lease owner.");
  Retire(lease);
  napi_get_undefined(env, &result);
  return result;
}
napi_value WrapLease(napi_env env, IOSurfaceRef surface) {
  auto* lease = new (std::nothrow) Lease{surface};
  if (!lease) { CFRelease(surface); return Fail(env, "Could not allocate an IOSurface lease."); }
  IOSurfaceIncrementUseCount(surface);
  napi_value object, handle, close;
  bool wrapped = false;
  const auto fail = [&]() -> napi_value {
    if (wrapped) Retire(lease);
    else FinalizeLease(env, lease, nullptr);
    return Fail(env, "Could not create the owned IOSurface wrapper.");
  };
  if (napi_create_object(env, &object) != napi_ok ||
      napi_type_tag_object(env, object, &kLeaseTag) != napi_ok ||
      napi_wrap(env, object, lease, FinalizeLease, nullptr, nullptr) != napi_ok) return fail();
  wrapped = true;
  if (napi_create_buffer_copy(env, sizeof(surface), &surface, nullptr, &handle) != napi_ok ||
      napi_create_function(env, "close", NAPI_AUTO_LENGTH, CloseLease, nullptr, &close) != napi_ok ||
      napi_set_named_property(env, object, "handle", handle) != napi_ok ||
      napi_set_named_property(env, object, "close", close) != napi_ok) return fail();
  return object;
}
void RetireChannel(Channel* channel) {
  if (!MACH_PORT_VALID(channel->port)) return;
  // Dynamic bootstrap registrations retire with their receive right; registering
  // MACH_PORT_NULL over an active binding is rejected as NAME_IN_USE.
  const auto status = channel->receiver ? mach_port_destroy(mach_task_self(), channel->port)
      : mach_port_deallocate(mach_task_self(), channel->port);
  if (status != KERN_SUCCESS)
    std::fprintf(stderr, "Native surface channel cleanup failed: %d\n", status);
  channel->port = MACH_PORT_NULL;
}
void FinalizeChannel(napi_env, void* data, void*) {
  auto* channel = static_cast<Channel*>(data);
  RetireChannel(channel);
  delete channel;
}
Channel* Owner(napi_env env, napi_value object) {
  bool tagged = false;
  Channel* channel = nullptr;
  if (napi_check_object_type_tag(env, object, &kChannelTag, &tagged) != napi_ok || !tagged ||
      napi_unwrap(env, object, reinterpret_cast<void**>(&channel)) != napi_ok) return nullptr;
  return channel;
}
napi_value CloseChannel(napi_env env, napi_callback_info info) {
  napi_value self, result;
  size_t count = 0;
  if (napi_get_cb_info(env, info, &count, nullptr, &self, nullptr) != napi_ok)
    return Fail(env, "Invalid Mach channel owner.");
  auto* channel = Owner(env, self);
  if (!channel) return Fail(env, "Invalid Mach channel owner.");
  RetireChannel(channel);
  napi_get_undefined(env, &result);
  return result;
}
napi_value Send(napi_env env, napi_callback_info info) {
  napi_value args[2], self, result;
  size_t count = 2, bytes = 0;
  void* input = nullptr;
  bool buffer = false;
  double frame_id;
  if (napi_get_cb_info(env, info, &count, args, &self, nullptr) != napi_ok || count != 2 ||
      napi_is_buffer(env, args[0], &buffer) != napi_ok || !buffer ||
      napi_get_buffer_info(env, args[0], &input, &bytes) != napi_ok || bytes != sizeof(uint64_t) ||
      !Number(env, args[1], 9007199254740991.0, &frame_id))
    return Fail(env, "A local IOSurface ID and owned frame identity are required.");
  auto* channel = Owner(env, self);
  if (!channel || channel->receiver || !MACH_PORT_VALID(channel->port))
    return Fail(env, "The surface sender is closed.");
  uint64_t id = 0;
  std::memcpy(&id, input, sizeof(id));
  if (!id || id > UINT32_MAX) return Fail(env, "Invalid local IOSurface ID.");
  const auto surface = IOSurfaceLookup(static_cast<IOSurfaceID>(id));
  if (!surface) return Fail(env, "The sender does not own this IOSurface.");
  const auto right = IOSurfaceCreateMachPort(surface);
  CFRelease(surface);
  if (!MACH_PORT_VALID(right)) return Fail(env, "Could not create an IOSurface send right.");
  SurfaceMessage message{};
  message.header.msgh_bits = MACH_MSGH_BITS(MACH_MSG_TYPE_COPY_SEND, 0) | MACH_MSGH_BITS_COMPLEX;
  message.header.msgh_size = sizeof(message);
  message.header.msgh_remote_port = channel->port;
  message.header.msgh_id = kMessageId;
  message.body.msgh_descriptor_count = 1;
  message.surface.name = right;
  message.surface.disposition = MACH_MSG_TYPE_COPY_SEND;
  message.surface.type = MACH_MSG_PORT_DESCRIPTOR;
  message.frame_id = static_cast<uint64_t>(frame_id);
  const auto status = mach_msg(&message.header, MACH_SEND_MSG | MACH_SEND_TIMEOUT,
      sizeof(message), 0, MACH_PORT_NULL, 0, MACH_PORT_NULL);
  mach_port_deallocate(mach_task_self(), right);
  if (status != KERN_SUCCESS) return Fail(env, "The bounded IOSurface transfer queue could not admit this frame.");
  napi_get_undefined(env, &result);
  return result;
}
napi_value Receive(napi_env env, napi_callback_info info) {
  napi_value args[3], self;
  size_t count = 3;
  double frame_id, width, height;
  if (napi_get_cb_info(env, info, &count, args, &self, nullptr) != napi_ok || count != 3 ||
      !Number(env, args[0], 9007199254740991.0, &frame_id) ||
      !Number(env, args[1], 3840, &width) || !Number(env, args[2], 2160, &height) ||
      width < 4 || height < 2 || std::fmod(width, 2) || std::fmod(height, 2))
    return Fail(env, "An owned frame identity and bounded NV12 dimensions are required.");
  auto* channel = Owner(env, self);
  if (!channel || !channel->receiver || !MACH_PORT_VALID(channel->port))
    return Fail(env, "The surface receiver is closed.");
  struct {
    SurfaceMessage message;
    mach_msg_max_trailer_t trailer;
  } storage{};
  auto& message = storage.message;
  const auto status = mach_msg(&message.header, MACH_RCV_MSG | MACH_RCV_TIMEOUT |
      MACH_RCV_TRAILER_TYPE(MACH_MSG_TRAILER_FORMAT_0) | MACH_RCV_TRAILER_ELEMENTS(MACH_RCV_TRAILER_AUDIT),
      0, sizeof(storage), channel->port, 0, MACH_PORT_NULL);
  if (status != KERN_SUCCESS) return Fail(env, "The announced IOSurface right was not queued.");
  struct Destroy {
    mach_msg_header_t* header;
    ~Destroy() { mach_msg_destroy(header); }
  } cleanup{&message.header};
  if (message.header.msgh_id != kMessageId || message.header.msgh_size != sizeof(message) ||
      !(message.header.msgh_bits & MACH_MSGH_BITS_COMPLEX) || message.body.msgh_descriptor_count != 1 ||
      message.surface.type != MACH_MSG_PORT_DESCRIPTOR || message.frame_id != static_cast<uint64_t>(frame_id))
    return Fail(env, "The Mach surface envelope does not match this frame.");
  const auto* trailer = reinterpret_cast<const mach_msg_audit_trailer_t*>(
      reinterpret_cast<const uint8_t*>(&storage) + round_msg(message.header.msgh_size));
  if (trailer->msgh_trailer_type != MACH_MSG_TRAILER_FORMAT_0 ||
      trailer->msgh_trailer_size < sizeof(mach_msg_audit_trailer_t) ||
      audit_token_to_pid(trailer->msgh_audit) != channel->peer ||
      audit_token_to_euid(trailer->msgh_audit) != geteuid())
    return Fail(env, "The IOSurface right did not originate from the owned RTC process.");
  const auto surface = IOSurfaceLookupFromMachPort(message.surface.name);
  if (!surface) return Fail(env, "The received IOSurface right is invalid.");
  if (IOSurfaceGetWidth(surface) != static_cast<size_t>(width) ||
      IOSurfaceGetHeight(surface) != static_cast<size_t>(height) ||
      IOSurfaceGetPixelFormat(surface) != '420v' || IOSurfaceGetPlaneCount(surface) != 2) {
    CFRelease(surface);
    return Fail(env, "IOSurface identity does not match its decoded frame.");
  }
  return WrapLease(env, surface);
}
napi_value WrapChannel(napi_env env, Channel* channel) {
  napi_value object, name;
  if (napi_create_object(env, &object) != napi_ok ||
      napi_type_tag_object(env, object, &kChannelTag) != napi_ok ||
      napi_wrap(env, object, channel, FinalizeChannel, nullptr, nullptr) != napi_ok) {
    FinalizeChannel(env, channel, nullptr);
    return Fail(env, "Could not wrap the Mach surface channel.");
  }
  const napi_property_descriptor properties[] = {
    {"close", nullptr, CloseChannel, nullptr, nullptr, nullptr, napi_default, nullptr},
    {channel->receiver ? "receiveSurface" : "sendSurface", nullptr,
      channel->receiver ? Receive : Send, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, object, 2, properties) != napi_ok ||
      napi_create_string_utf8(env, channel->name, NAPI_AUTO_LENGTH, &name) != napi_ok ||
      napi_set_named_property(env, object, "name", name) != napi_ok) {
    RetireChannel(channel);
    return Fail(env, "Could not initialize the Mach surface channel.");
  }
  return object;
}
napi_value CreateReceiver(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t count = 1;
  double pid;
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 1 ||
      !Number(env, args[0], INT32_MAX, &pid) || pid == getpid())
    return Fail(env, "The owned RTC child PID is required.");
  auto* channel = new (std::nothrow) Channel;
  if (!channel) return Fail(env, "Could not allocate the Mach receiver.");
  channel->peer = static_cast<pid_t>(pid);
  channel->receiver = true;
  const auto uuid = CFUUIDCreate(kCFAllocatorDefault);
  const auto text = uuid ? CFUUIDCreateString(kCFAllocatorDefault, uuid) : nullptr;
  char token[64]{};
  const bool named = text && CFStringGetCString(text, token, sizeof(token), kCFStringEncodingASCII);
  if (text) CFRelease(text);
  if (uuid) CFRelease(uuid);
  if (!named) { delete channel; return Fail(env, "Could not name the private surface receiver."); }
  std::snprintf(channel->name, sizeof(channel->name), "com.monky.surface.%s", token);
  mach_port_limits_t limits{64};
  if (mach_port_allocate(mach_task_self(), MACH_PORT_RIGHT_RECEIVE, &channel->port) != KERN_SUCCESS ||
      mach_port_set_attributes(mach_task_self(), channel->port, MACH_PORT_LIMITS_INFO,
        reinterpret_cast<mach_port_info_t>(&limits), MACH_PORT_LIMITS_INFO_COUNT) != KERN_SUCCESS ||
      mach_port_insert_right(mach_task_self(), channel->port, channel->port, MACH_MSG_TYPE_MAKE_SEND) != KERN_SUCCESS ||
      bootstrap_register(bootstrap_port, channel->name, channel->port) != KERN_SUCCESS) {
    FinalizeChannel(env, channel, nullptr);
    return Fail(env, "Could not register the private surface receiver.");
  }
  return WrapChannel(env, channel);
}
napi_value OpenSender(napi_env env, napi_callback_info info) {
  napi_value args[1];
  size_t count = 1, size = 0;
  char name[128]{};
  if (napi_get_cb_info(env, info, &count, args, nullptr, nullptr) != napi_ok || count != 1 ||
      napi_get_value_string_utf8(env, args[0], name, sizeof(name), &size) != napi_ok ||
      size != std::strlen("com.monky.surface.") + 36 || std::strncmp(name, "com.monky.surface.", 18) != 0)
    return Fail(env, "A private surface receiver name is required.");
  auto* channel = new (std::nothrow) Channel;
  if (!channel) return Fail(env, "Could not allocate the Mach sender.");
  std::memcpy(channel->name, name, size + 1);
  if (bootstrap_look_up(bootstrap_port, name, &channel->port) != KERN_SUCCESS) {
    delete channel;
    return Fail(env, "Could not connect to the owned surface receiver.");
  }
  return WrapChannel(env, channel);
}
napi_value Initialize(napi_env env, napi_value exports) {
  const napi_property_descriptor properties[] = {
    {"createReceiver", nullptr, CreateReceiver, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"openSender", nullptr, OpenSender, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  if (napi_define_properties(env, exports, 2, properties) != napi_ok)
    return Fail(env, "Could not initialize IOSurface ownership.");
  return exports;
}
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Initialize)
