"""Spatial primitives for published Diviner PRP triangular facets.

No grid ordering is assumed. A geocentric site ray is intersected with the published
triangle vertices; the per-facet quantities are retained without interpolation.
"""
import numpy as np

RADIUS_KM = 1737.4


def direction(lat, lon):
    lat, lon = np.deg2rad([lat, lon])
    return np.array([np.cos(lat)*np.cos(lon), np.cos(lat)*np.sin(lon), np.sin(lat)])


def ray_triangle(point, vertices, tolerance=1e-8):
    """Moller-Trumbore ray intersection; return barycentric weights/range or None."""
    a, b, c = np.asarray(vertices, dtype=float)
    edge1, edge2 = b-a, c-a
    h = np.cross(point, edge2)
    det = np.dot(edge1, h)
    if abs(det) < 1e-12:
        return None
    s = -a
    u = np.dot(s,h)/det
    q = np.cross(s,edge1)
    v = np.dot(point,q)/det
    radius = np.dot(edge2,q)/det
    if u < -tolerance or v < -tolerance or u+v > 1+tolerance or radius <= 0:
        return None
    return np.array([1-u-v, u, v]), float(radius)


def great_circle_m(a, b):
    return float(np.arctan2(np.linalg.norm(np.cross(a,b)),np.dot(a,b))*RADIUS_KM*1000)


def contains_by_edges(point, vertices):
    """Separate spherical half-space check, also usable across the entire table."""
    v = np.asarray(vertices)
    signs = np.stack([np.cross(v[...,0,:],v[...,1,:]) @ point,
        np.cross(v[...,1,:],v[...,2,:]) @ point,
        np.cross(v[...,2,:],v[...,0,:]) @ point],axis=-1)
    # Edge signs alone also accept the antipodal triangle; require the forward hemisphere.
    return (np.all(signs >= -1e-7,axis=-1) | np.all(signs <= 1e-7,axis=-1)) & (np.mean(v,axis=-2) @ point > 0)
