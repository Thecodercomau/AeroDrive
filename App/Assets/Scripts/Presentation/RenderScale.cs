using UnityEngine;

namespace AeroDrive.Presentation
{
    /// <summary>
    /// Applies a render resolution that is a fraction of the window's.
    /// </summary>
    /// <remarks>
    /// Render scale is the most effective single lever for frame rate on a car game, because the
    /// cost of the whole frame is close to proportional to the pixel count. It is also the least
    /// destructive one, because it blurs the image rather than removing geometry or shadows.
    ///
    /// This uses dynamic resolution, which is the built-in pipeline's support for it. On a platform
    /// that does not support dynamic resolution the calls are no-ops, so a player who sets 50%
    /// simply keeps their native resolution instead of seeing a broken image.
    ///
    /// If the project is moved to URP, replace the body of <see cref="Apply"/> with a write to
    /// <c>UniversalRenderPipeline.asset.renderScale</c>: URP's own scale and this one must not both
    /// be active.
    /// </remarks>
    public static class RenderScale
    {
        /// <summary>Lowest scale the game will apply. Below this the image stops being readable.</summary>
        public const float Minimum = 0.5f;

        private static float _current = 1f;

        /// <summary>The scale currently applied.</summary>
        public static float Current
        {
            get { return _current; }
        }

        /// <summary>True when this platform and camera can actually honour a render scale.</summary>
        public static bool IsSupported(Camera camera)
        {
            return camera != null && SystemInfo.supportsDynamicResolution;
        }

        /// <summary>Apply a render scale to a camera. Values are clamped to a usable range.</summary>
        public static void Apply(Camera camera, float scale)
        {
            if (camera == null) return;

            scale = Mathf.Clamp(scale <= 0f ? 1f : scale, Minimum, 1f);
            _current = scale;

            // The flag has to be set before the buffers are resized, and only when a scale is
            // actually in use: leaving it on costs a little on some platforms for no benefit.
            camera.allowDynamicResolution = scale < 0.999f;

            if (!SystemInfo.supportsDynamicResolution) return;

            ScalableBufferManager.ResizeBuffers(scale, scale);
        }
    }
}
