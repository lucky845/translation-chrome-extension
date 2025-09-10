import os
from PIL import Image, ImageDraw, ImageFont

# 确保icons目录存在
save_dir = './icons'
if not os.path.exists(save_dir):
    os.makedirs(save_dir)

# 需要生成的图标尺寸
sizes = [16, 32, 48, 128]

# 定义主题色（参考用户提供的示例）
primary_color = '#4285f4'     # 主蓝色
secondary_color = '#ffffff'   # 白色
tertiary_color = '#34a853'    # 绿色强调色

def draw_book_style_logo(size):
    # 创建新图像
    image = Image.new('RGBA', (size, size), (0, 0, 0, 0))  # 透明背景
    draw = ImageDraw.Draw(image)
    
    # 为不同尺寸调整比例
    scale = size / 48  # 以48px为基准比例
    
    # 计算书本形状尺寸
    book_width = int(36 * scale)
    book_height = int(40 * scale)
    book_x = (size - book_width) // 2
    book_y = (size - book_height) // 2
    
    # 绘制书本形状
    # 左侧封面（蓝色）
    left_cover_width = int(book_width * 0.5)
    draw.rectangle([(book_x, book_y), (book_x + left_cover_width, book_y + book_height)], fill=primary_color)
    
    # 右侧页面（白色）
    right_page_x = book_x + left_cover_width
    draw.rectangle([(right_page_x, book_y), (book_x + book_width, book_y + book_height)], fill=secondary_color)
    
    # 绘制书脊
    spine_width = int(2 * scale)
    draw.rectangle([(book_x - spine_width, book_y), (book_x, book_y + book_height)], fill=primary_color)
    
    # 尝试加载适合中文字体的系统字体
    try:
        # 调整字体大小以适应不同尺寸
        if size >= 48:
            font_size = int(20 * scale)
        elif size >= 32:
            font_size = int(16 * scale)
        else:
            font_size = int(12 * scale)
        font = ImageFont.truetype("Arial.ttf", font_size)
    except IOError:
        # 如果没有Arial字体，使用默认字体
        font = ImageFont.load_default()
    
    # 在左侧封面绘制"En"文本
    text_en = 'En'
    bbox_en = draw.textbbox((0, 0), text_en, font=font)
    text_en_width = bbox_en[2] - bbox_en[0]
    text_en_height = bbox_en[3] - bbox_en[1]
    text_en_x = book_x + left_cover_width // 2 - text_en_width // 2
    text_en_y = book_y + book_height // 2 - text_en_height // 2
    draw.text((text_en_x, text_en_y), text_en, font=font, fill=secondary_color)
    
    # 在右侧页面绘制"文"文本（仅在尺寸足够大时）
    if size >= 32:
        # 对于中文"文"字，可能需要调整字体大小
        text_zh = '文'
        if size >= 48:
            # 对于大尺寸，使用稍微小一点的字体以确保完整显示
            zh_font_size = int(18 * scale)
            try:
                zh_font = ImageFont.truetype("Arial.ttf", zh_font_size)
            except IOError:
                zh_font = font
            
            bbox_zh = draw.textbbox((0, 0), text_zh, font=zh_font)
            text_zh_width = bbox_zh[2] - bbox_zh[0]
            text_zh_height = bbox_zh[3] - bbox_zh[1]
            text_zh_x = right_page_x + (book_width - left_cover_width) // 2 - text_zh_width // 2
            text_zh_y = book_y + book_height // 2 - text_zh_height // 2
            draw.text((text_zh_x, text_zh_y), text_zh, font=zh_font, fill=primary_color)
        else:
            # 对于中等尺寸，使用简化的符号表示中文
            # 绘制一个简化的"文"字或符号
            symbol_size = int(12 * scale)
            symbol_x = right_page_x + (book_width - left_cover_width) // 2 - symbol_size // 2
            symbol_y = book_y + book_height // 2 - symbol_size // 2
            
            # 简化的"文"字符号
            # 一横
            draw.line([(symbol_x, symbol_y), (symbol_x + symbol_size, symbol_y)], fill=primary_color, width=int(2 * scale))
            # 一点
            draw.ellipse([(symbol_x + symbol_size // 2 - int(2 * scale), symbol_y - int(4 * scale)), 
                         (symbol_x + symbol_size // 2 + int(2 * scale), symbol_y - int(0 * scale))], fill=primary_color)
            # 一撇
            draw.line([(symbol_x, symbol_y + int(4 * scale)), (symbol_x + symbol_size, symbol_y)], fill=primary_color, width=int(2 * scale))
    
    # 添加装饰性元素，如页面阴影
    if size >= 32:
        # 绘制页面阴影效果
        shadow_width = int(3 * scale)
        shadow_height = int(3 * scale)
        draw.rectangle([(right_page_x, book_y + book_height), (right_page_x + shadow_width, book_y + book_height + shadow_height)], fill=(0, 0, 0, 100))
        draw.rectangle([(book_x + book_width, book_y), (book_x + book_width + shadow_width, book_y + book_height)], fill=(0, 0, 0, 100))
    
    # 对于小尺寸(16px)，简化设计
    if size < 32:
        # 简化为书本图标和翻译符号
        # 清除之前的绘制内容
        image = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        draw = ImageDraw.Draw(image)
        
        # 绘制简化的书本形状
        draw.rectangle([(size // 4, size // 4), (size * 3 // 4, size * 3 // 4)], fill=primary_color)
        draw.rectangle([(size * 5 // 12, size * 5 // 16), (size * 7 // 12, size * 3 // 4)], fill=secondary_color)
        
        # 绘制简化的翻译符号
        line_width = int(1 * scale)
        if size >= 16:
            # 左侧字母'E'的简化表示
            draw.line([(size // 4 + int(2 * scale), size // 2 - int(3 * scale)), (size // 4 + int(6 * scale), size // 2 - int(3 * scale))], fill=secondary_color, width=line_width)
            draw.line([(size // 4 + int(2 * scale), size // 2), (size // 4 + int(6 * scale), size // 2)], fill=secondary_color, width=line_width)
            draw.line([(size // 4 + int(2 * scale), size // 2 + int(3 * scale)), (size // 4 + int(6 * scale), size // 2 + int(3 * scale))], fill=secondary_color, width=line_width)
            draw.line([(size // 4 + int(2 * scale), size // 2 - int(3 * scale)), (size // 4 + int(2 * scale), size // 2 + int(3 * scale))], fill=secondary_color, width=line_width)
            
            # 右侧中文的简化表示
            draw.line([(size * 7 // 12, size // 2 - int(3 * scale)), (size * 7 // 12, size // 2 + int(3 * scale))], fill=primary_color, width=line_width)
            draw.line([(size * 7 // 12, size // 2 - int(3 * scale)), (size * 11 // 12, size // 2)], fill=primary_color, width=line_width)
            draw.line([(size * 7 // 12, size // 2 + int(3 * scale)), (size * 11 // 12, size // 2)], fill=primary_color, width=line_width)
    
    return image

# 生成并保存所有尺寸的图标
for size in sizes:
    logo = draw_book_style_logo(size)
    logo.save(f'{save_dir}/icon-{size}.png', 'PNG')
    print(f'已生成 {save_dir}/icon-{size}.png')

print('所有书本风格翻译图标已生成完成!')