"""Check actual RT_GROUP_ICON sizes embedded in Windows executables."""
from pathlib import Path
import json
import struct
import sys

EXPECTED = {16, 20, 24, 28, 32, 40, 48, 64, 96, 128, 256}

def inspect(filename):
    data = Path(filename).read_bytes()
    pe = struct.unpack_from('<I', data, 0x3c)[0]
    assert data[pe:pe+4] == b'PE\0\0', 'Not a Windows PE executable'
    section_count = struct.unpack_from('<H', data, pe+6)[0]
    optional_size = struct.unpack_from('<H', data, pe+20)[0]
    optional = pe+24
    magic = struct.unpack_from('<H', data, optional)[0]
    directory = optional+(112 if magic == 0x20b else 96)
    resource_rva = struct.unpack_from('<I', data, directory+16)[0]
    sections = []
    for i in range(section_count):
        off = optional+optional_size+i*40
        virtual_size, virtual_address, raw_size, raw_offset = struct.unpack_from('<IIII', data, off+8)
        sections.append((virtual_address, max(virtual_size,raw_size), raw_offset))
    def offset(rva):
        for va,size,raw in sections:
            if va <= rva < va+size:
                return raw+rva-va
        raise ValueError('Unmapped resource RVA')
    base = offset(resource_rva)
    def entries(relative):
        pos = base+relative
        named,ids = struct.unpack_from('<HH',data,pos+12)
        return [struct.unpack_from('<II',data,pos+16+i*8) for i in range(named+ids)]
    groups = []
    def leaves(relative):
        for name,value in entries(relative):
            if value & 0x80000000:
                yield from leaves(value & 0x7fffffff)
            else:
                rva,size = struct.unpack_from('<II',data,base+value)
                yield data[offset(rva):offset(rva)+size]
    for kind,value in entries(0):
        if kind != 14:
            continue
        for name,group_dir in entries(value & 0x7fffffff):
            for raw in leaves(group_dir & 0x7fffffff):
                count = struct.unpack_from('<H',raw,4)[0]
                sizes = sorted({raw[6+i*14] or 256 for i in range(count)})
                groups.append({'id':name,'sizes':sizes})
    assert any(EXPECTED.issubset(set(group['sizes'])) for group in groups), f'Missing icon sizes: {groups}'
    return {'file':Path(filename).name,'groups':groups,'all_sizes_embedded':True}

for argument in sys.argv[1:]:
    print(json.dumps(inspect(argument)))
