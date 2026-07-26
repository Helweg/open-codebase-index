#include <metal_stdlib>
using namespace metal;

struct VertexIn {
  float3 position [[attribute(0)]];
  float2 uv [[attribute(1)]];
};

struct VertexOut {
  float4 position [[position]];
  float2 uv;
};

struct Uniforms {
  float4x4 transform;
  float gain;
};

struct Tiny { float value; };

enum class BlendMode : uint { normal, additive };

union ScalarBits { float value; uint bits; };

using Gain = float;

typedef Uniforms LegacyUniforms;

struct Ops {
  inline float adjust(float value) const {
    return value + 1.0f;
  }
};

template <typename T>
struct BufferPair {
  const device T* input;
  device T* output;
};

template <>
struct BufferPair<float> {
  const device float* input;
  device float* output;
};

template <typename T>
inline T scaled_value(T value, constant float& scale) {
  return value * T(scale);
}

// Samples the texture and applies the gain provided by the constants.
inline float4 shade(texture2d<float> color_texture,
                    sampler color_sampler,
                    float2 uv,
                    constant Uniforms& uniforms) {
  float gain = metal::clamp(uniforms.gain, 0.0f, 1.0f);
  float4 sampled = color_texture.sample(color_sampler, uv);
  return sampled * gain;
}

vertex VertexOut vertex_main(VertexIn in [[stage_in]],
                             constant Uniforms& uniforms [[buffer(0)]],
                             uint vertex_id [[vertex_id]]) {
  VertexOut out;
  out.position = uniforms.transform * float4(in.position, 1.0f);
  out.uv = in.uv + float2(vertex_id == 0 ? 0.0f : 0.0f);
  return out;
}

fragment float4 fragment_main(VertexOut in [[stage_in]],
                              texture2d<float> color_texture [[texture(0)]],
                              sampler color_sampler [[sampler(0)]],
                              constant Uniforms& uniforms [[buffer(0)]]) {
  return shade(color_texture, color_sampler, in.uv, uniforms);
}

kernel void reduce_kernel(const device float* input [[buffer(0)]],
                          device float* output [[buffer(1)]],
                          constant uint& count [[buffer(2)]],
                          constant float& scale [[buffer(3)]],
                          threadgroup float* scratch [[threadgroup(0)]],
                          uint gid [[thread_position_in_grid]],
                          uint lid [[thread_position_in_threadgroup]])
    [[max_total_threads_per_threadgroup(256)]] {
  thread float value = gid < count ? input[gid] : 0.0f;
  scratch[lid] = scaled_value<float>(value, scale);
  threadgroup_barrier(mem_flags::mem_threadgroup);
  Ops ops;
  output[gid] = ops.adjust(simd_sum(scratch[lid]));
}
