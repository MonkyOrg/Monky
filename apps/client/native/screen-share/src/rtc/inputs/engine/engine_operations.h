#pragma once

// Every operation the engine accepts, with its scope and what undoing it means. An operation is undone when JS
// cancelled it, or its deadline passed, after the native work completed: the native state must then match what JS
// believes. One table replaces the name lists the request check, the completion and the rollback kept in parallel.

#include <algorithm>
#include <cstdint>
#include <iterator>
#include <string_view>

namespace monky::native_rtc::engine {

// Target zero creates; any other target names a live resource of the engine.
enum class OperationScope : std::uint8_t { kCreates, kResource };

enum class Rollback : std::uint8_t {
  // Queries, offers/answers and closes leave nothing to undo.
  kNone,
  kStopAudioOutput,
  // The source stops publishing; an audio source also stops accepting capture.
  kDisableSource,
  // Retires the resource the result reports, or the target: a created or changed source, peer, publication, device,
  // transport or consumer. JS retires the owner of a failed command too; this keeps native state from outliving it.
  kRetire,
  // SFU producer and consumer work: closing them would need the cancelled server acknowledgement, so their native
  // transport is retired instead.
  kRetireTransport,
};

struct OperationSpec {
  std::string_view name;
  OperationScope scope;
  Rollback rollback;
  // Refreshes the controller snapshot it reports, also when it fails.
  bool observes_control = false;
};

inline constexpr OperationSpec kOperations[] = {
    {"source.createEncodedVideo", OperationScope::kCreates, Rollback::kRetire},
    {"source.createAudio", OperationScope::kCreates, Rollback::kRetire},
    {"source.beginAudioEpoch", OperationScope::kResource, Rollback::kDisableSource},
    {"source.setAudioSyncGroup", OperationScope::kResource, Rollback::kDisableSource},
    {"source.setEnabled", OperationScope::kResource, Rollback::kDisableSource},
    {"audio.configureOutput", OperationScope::kCreates, Rollback::kStopAudioOutput},
    {"audio.stopOutput", OperationScope::kCreates, Rollback::kNone},
    {"resource.close", OperationScope::kResource, Rollback::kNone},
    {"peer.create", OperationScope::kCreates, Rollback::kRetire},
    {"peer.createOffer", OperationScope::kResource, Rollback::kNone},
    {"peer.createAnswer", OperationScope::kResource, Rollback::kNone},
    {"peer.setLocalDescription", OperationScope::kResource, Rollback::kRetire},
    {"peer.setRemoteDescription", OperationScope::kResource, Rollback::kRetire},
    {"peer.addIceCandidate", OperationScope::kResource, Rollback::kRetire},
    {"peer.publish", OperationScope::kResource, Rollback::kRetire},
    {"peer.publishAudio", OperationScope::kResource, Rollback::kRetire},
    {"peer.setReceiverVolume", OperationScope::kResource, Rollback::kRetire},
    {"peer.setPublicationEnabled", OperationScope::kResource, Rollback::kRetire},
    {"peer.setReceiving", OperationScope::kResource, Rollback::kRetire},
    {"peer.setReceiverEnabled", OperationScope::kResource, Rollback::kRetire},
    {"peer.getStats", OperationScope::kResource, Rollback::kNone, true},
    {"peer.configureBitrate", OperationScope::kResource, Rollback::kRetire},
    {"peer.configureVideoPlayout", OperationScope::kResource, Rollback::kRetire},
    {"sfu.load", OperationScope::kCreates, Rollback::kRetire},
    {"sfu.createTransport", OperationScope::kResource, Rollback::kRetire},
    {"sfu.produce", OperationScope::kResource, Rollback::kRetireTransport},
    {"sfu.consume", OperationScope::kResource, Rollback::kRetireTransport},
    {"sfu.setProducerEnabled", OperationScope::kResource, Rollback::kRetireTransport},
    {"sfu.setConsumerEnabled", OperationScope::kResource, Rollback::kRetireTransport},
    {"sfu.setConsumerVolume", OperationScope::kResource, Rollback::kRetire},
    {"sfu.restartIce", OperationScope::kResource, Rollback::kRetire},
    {"sfu.getStats", OperationScope::kResource, Rollback::kNone, true},
};

inline const OperationSpec* FindOperation(std::string_view name) {
  const auto found = std::find_if(std::begin(kOperations), std::end(kOperations),
                                  [&](const OperationSpec& spec) { return spec.name == name; });
  return found == std::end(kOperations) ? nullptr : &*found;
}

}  // namespace monky::native_rtc::engine
