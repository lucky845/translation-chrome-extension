import os
from PIL import Image

# 确保icons目录存在
save_dir = './icons'
if not os.path.exists(save_dir):
    os.makedirs(save_dir)

# 源PNG文件路径
source_png = os.path.join(save_dir, '翻译.png')

# 需要生成的图标尺寸
sizes = [16, 32, 48, 128]

# 检查源文件是否存在
if not os.path.exists(source_png):
    print(f'错误: 源文件 {source_png} 不存在!')
    exit(1)

# 尝试打开源文件并调整大小
try:
    # 打开源图像
    source_image = Image.open(source_png)
    
    # 显示源图像信息
    print(f'源图像信息: {source_image.size} 像素, {source_image.mode} 模式')
    
    # 遍历所有尺寸并生成调整大小后的图标
    for size in sizes:
        try:
            # 调整图像大小
            # 使用LANCZOS过滤器确保高质量的缩小效果
            resized_image = source_image.resize((size, size), Image.Resampling.LANCZOS)
            
            # 保存为PNG文件
            output_path = os.path.join(save_dir, f'icon-{size}.png')
            resized_image.save(output_path, 'PNG')
            print(f'已生成 {output_path} ({size}x{size} 像素)')
        except Exception as e:
            print(f'生成尺寸为{size}的图标时出错: {str(e)}')
    
    print('所有图标已成功生成!')
    
except Exception as e:
    print(f'处理图像时出错: {str(e)}')