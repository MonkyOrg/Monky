#pragma once

#include "../packet_core.h"
#include <libproc.h>
#include <unordered_set>

namespace screen_audio {
inline std::unordered_set<uint32_t> ProcessTree(uint32_t root) {
  if (!root) throw Failure("ERR_AUDIO_TARGET", "Invalid audio process tree root");
  std::unordered_set<uint32_t> tree{root};
  std::vector<uint32_t> pending{root};
  std::vector<pid_t> children(128);
  constexpr size_t limit = 65536;
  for (size_t index = 0; index < pending.size(); ++index) {
    int bytes;
    while (true) {
      bytes = proc_listpids(PROC_PPID_ONLY, pending[index], children.data(),
          static_cast<int>(children.size() * sizeof(pid_t)));
      if (bytes < 0 || bytes % sizeof(pid_t))
        throw Failure("ERR_AUDIO_TARGET", "Cannot enumerate the Monky audio process tree");
      if (static_cast<size_t>(bytes) < children.size() * sizeof(pid_t)) break;
      if (children.size() >= limit)
        throw Failure("ERR_AUDIO_TARGET", "Unbounded audio process tree");
      children.resize(children.size() * 2);
    }
    for (size_t child = 0; child < static_cast<size_t>(bytes) / sizeof(pid_t); ++child) {
      if (children[child] <= 0 || !tree.insert(children[child]).second) continue;
      if (tree.size() > limit) throw Failure("ERR_AUDIO_TARGET", "Unbounded audio process tree");
      pending.push_back(children[child]);
    }
  }
  return tree;
}
}
