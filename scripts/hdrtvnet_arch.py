# Adapted from HDRTVNet++ (MIT), copyright (c) 2023 Hoven Li.
# Upstream c77ad33a2d186482ef1f4d23990cbf39d8dbd727; see include/hdrtvnet/LICENSE.
import functools
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch.nn import init


def initialize_weights(net_l, scale=1):
    if not isinstance(net_l, list):
        net_l = [net_l]
    for net in net_l:
        for m in net.modules():
            if isinstance(m, nn.Conv2d):
                init.kaiming_normal_(m.weight, a=0, mode='fan_in')
                m.weight.data *= scale  # for residual block
                if m.bias is not None:
                    m.bias.data.zero_()
            elif isinstance(m, nn.Linear):
                init.kaiming_normal_(m.weight, a=0, mode='fan_in')
                m.weight.data *= scale
                if m.bias is not None:
                    m.bias.data.zero_()
            elif isinstance(m, nn.BatchNorm2d):
                init.constant_(m.weight, 1)
                init.constant_(m.bias.data, 0.0)


def make_layer(block, n_layers):
    layers = []
    for _ in range(n_layers):
        layers.append(block())
    return nn.Sequential(*layers)


class SFTLayer(nn.Module):
    def __init__(self, in_nc=32, out_nc=64, nf=32):
        super(SFTLayer, self).__init__()
        self.SFT_scale_conv0 = nn.Conv2d(in_nc, nf, 1)
        self.SFT_scale_conv1 = nn.Conv2d(nf, out_nc, 1)
        self.SFT_shift_conv0 = nn.Conv2d(in_nc, nf, 1)
        self.SFT_shift_conv1 = nn.Conv2d(nf, out_nc, 1)

    def forward(self, x):
        # x[0]: fea; x[1]: cond
        scale = self.SFT_scale_conv1(F.leaky_relu(self.SFT_scale_conv0(x[1]), 0.1, inplace=True))
        shift = self.SFT_shift_conv1(F.leaky_relu(self.SFT_shift_conv0(x[1]), 0.1, inplace=True))
        return x[0] * (scale + 1) + shift


class ResBlock_with_SFT(nn.Module):
    def __init__(self, nf=64):
        super(ResBlock_with_SFT, self).__init__()
        self.conv1 = nn.Conv2d(nf, nf, 3, 1, 1, bias=True)
        self.conv2 = nn.Conv2d(nf, nf, 3, 1, 1, bias=True)

        self.sft1 = SFTLayer(in_nc=nf//2, out_nc=nf, nf=nf//2)
        self.conv1 = nn.Conv2d(nf, nf, 3, 1, 1)
        self.sft2 = SFTLayer(in_nc=nf//2, out_nc=nf, nf=nf//2)
        self.conv2 = nn.Conv2d(nf, nf, 3, 1, 1)

        # initialization
        initialize_weights([self.conv1, self.conv2], 0.1)

    def forward(self, x):
        # x[0]: fea; x[1]: cond
        fea = self.sft1(x)
        fea = F.relu(self.conv1(fea), inplace=True)
        fea = self.sft2((fea, x[1]))
        fea = self.conv2(fea)
        return (x[0] + fea, x[1])


def color_block(in_filters, out_filters, normalization=False):
    conv = nn.Conv2d(in_filters, out_filters, 1, stride=1, padding=0)
    pooling = nn.AvgPool2d(3, stride=2, padding=1, count_include_pad=True)
    act = nn.LeakyReLU(0.2)
    layers = [conv, pooling, act]
    if normalization:
        layers.append(nn.InstanceNorm2d(out_filters, affine=True))
    return layers


class Color_Condition(nn.Module):
    def __init__(self, in_channels=3, out_c=3):
        super(Color_Condition, self).__init__()

        self.model = nn.Sequential(
            *color_block(3, 16, normalization=True),
            *color_block(16, 32, normalization=True),
            *color_block(32, 64, normalization=True),
            *color_block(64, 128, normalization=True),
            *color_block(128, 128),
            nn.Dropout(p=0.5),
            nn.Conv2d(128, out_c, 1, stride=1, padding=0),
            nn.AdaptiveAvgPool2d(1),
        )

    def forward(self, img_input):
        return self.model(img_input)


class ConditionNet(nn.Module):
    def __init__(self, nf=64, classifier='color_condition', cond_c=3):
        super(ConditionNet, self).__init__()
        self.classifier = classifier
        if self.classifier == 'color_condition':
            self.classifier = Color_Condition(out_c=cond_c)

        self.GFM_nf = 64

        self.cond_scale_first = nn.Linear(cond_c, nf)
        self.cond_scale_HR = nn.Linear(cond_c, nf)
        self.cond_scale_last = nn.Linear(cond_c, 3)

        self.cond_shift_first = nn.Linear(cond_c, nf)
        self.cond_shift_HR = nn.Linear(cond_c, nf)
        self.cond_shift_last = nn.Linear(cond_c, 3)

        self.conv_first = nn.Conv2d(3, nf, 1, 1)
        self.HRconv = nn.Conv2d(nf, nf, 1, 1)
        self.conv_last = nn.Conv2d(nf, 3, 1, 1)
        self.act = nn.ReLU(inplace=True)

    def forward(self, x):
        content = x[0]
        condition = x[1]
        fea = self.classifier(condition).squeeze(2).squeeze(2)

        scale_first = self.cond_scale_first(fea)
        shift_first = self.cond_shift_first(fea)

        scale_HR = self.cond_scale_HR(fea)
        shift_HR = self.cond_shift_HR(fea)

        scale_last = self.cond_scale_last(fea)
        shift_last = self.cond_shift_last(fea)

        out = self.conv_first(content)
        out = out * scale_first.view(-1, self.GFM_nf, 1, 1) + shift_first.view(-1, self.GFM_nf, 1, 1) + out
        out = self.act(out)

        out = self.HRconv(out)
        out = out * scale_HR.view(-1, self.GFM_nf, 1, 1) + shift_HR.view(-1, self.GFM_nf, 1, 1) + out
        out = self.act(out)

        out = self.conv_last(out)
        out = out * scale_last.view(-1, 3, 1, 1) + shift_last.view(-1, 3, 1, 1) + out

        return out, x


class HDRUNet3T1(nn.Module):
    def __init__(self, in_nc=3, out_nc=3, nf=64, act_type='relu', weighting_network=True):
        super(HDRUNet3T1, self).__init__()

        self.conv_first = nn.Conv2d(in_nc, nf, 3, 1, 1)

        self.SFT_layer1 = SFTLayer(in_nc=nf//2, out_nc=nf, nf=nf//2)
        self.HR_conv1 = nn.Conv2d(nf, nf, 3, 1, 1, bias=True)

        self.down_conv1 = nn.Conv2d(nf, nf, 3, 2, 1)
        self.down_conv2 = nn.Conv2d(nf, nf, 3, 2, 1)
        self.down_conv3 = nn.Conv2d(nf, nf, 3, 2, 1)

        basic_block = functools.partial(ResBlock_with_SFT, nf=nf)
        self.recon_trunk1 = make_layer(basic_block, 1)
        self.recon_trunk2 = make_layer(basic_block, 1)
        self.recon_trunk3 = make_layer(basic_block, 4)
        self.recon_trunk4 = make_layer(basic_block, 1)
        self.recon_trunk5 = make_layer(basic_block, 1)


        self.up_conv1 = nn.Sequential(nn.Conv2d(nf, nf * 4, 3, 1, 1), nn.PixelShuffle(2))
        self.up_conv2 = nn.Sequential(nn.Conv2d(nf, nf * 4, 3, 1, 1), nn.PixelShuffle(2))
        self.up_conv3 = nn.Sequential(nn.Conv2d(nf, nf * 4, 3, 1, 1), nn.PixelShuffle(2))

        self.SFT_layer2 = SFTLayer(in_nc=nf//2, out_nc=nf, nf=nf//2)
        self.HR_conv2 = nn.Conv2d(nf, nf, 3, 1, 1, bias=True)
        self.conv_last = nn.Conv2d(nf, out_nc, 3, 1, 1, bias=True)

        cond_in_nc = 3
        cond_nf = 64
        self.cond_first = nn.Sequential(nn.Conv2d(cond_in_nc, cond_nf, 3, 1, 1), nn.LeakyReLU(0.1, True),
                                        nn.Conv2d(cond_nf, cond_nf, 1), nn.LeakyReLU(0.1, True),
                                        nn.Conv2d(cond_nf, cond_nf, 1), nn.LeakyReLU(0.1, True))
        self.CondNet1 = nn.Sequential(nn.Conv2d(cond_nf, cond_nf, 1), nn.LeakyReLU(0.1, True),
                                      nn.Conv2d(cond_nf, cond_nf, 1), nn.LeakyReLU(0.1, True),
                                      nn.Conv2d(cond_nf, nf//2, 1))
        self.CondNet2 = nn.Sequential(nn.Conv2d(cond_nf, cond_nf, 3, 2, 1), nn.LeakyReLU(0.1, True),
                                      nn.Conv2d(cond_nf, cond_nf, 1), nn.LeakyReLU(0.1, True),
                                      nn.Conv2d(cond_nf, nf//2, 1))
        self.CondNet3 = nn.Sequential(nn.Conv2d(cond_nf, cond_nf, 3, 2, 1), nn.LeakyReLU(0.1, True),
                                      nn.Conv2d(cond_nf, cond_nf, 3, 2, 1), nn.LeakyReLU(0.1, True),
                                      nn.Conv2d(cond_nf, nf//2, 1))
        self.CondNet4 = nn.Sequential(nn.Conv2d(cond_nf, cond_nf, 3, 2, 1), nn.LeakyReLU(0.1, True),
                                      nn.Conv2d(cond_nf, cond_nf, 3, 2, 1), nn.LeakyReLU(0.1, True),
                                      nn.Conv2d(cond_nf, nf//2, 3, 2, 1))

        self.weighting_network = weighting_network
        if weighting_network:
            self.mask_est = nn.Sequential(nn.Conv2d(in_nc, nf, 3, 1, 1),
                                          nn.ReLU(inplace=True),
                                          nn.Conv2d(nf, nf, 3, 1, 1),
                                          nn.ReLU(inplace=True),
                                          nn.Conv2d(nf, nf, 1),
                                          nn.ReLU(inplace=True),
                                          nn.Conv2d(nf, out_nc, 1),
                                          )

        # activation function
        if act_type == 'relu':
            self.act = nn.ReLU(inplace=True)
        elif act_type == 'leakyrelu':
            self.act = nn.LeakyReLU(negative_slope=0.1, inplace=True)

    def forward(self, x):
        # x[0]: img; x[1]: cond
        if self.weighting_network:
            mask = self.mask_est(x[0])
            mask_out = mask * x[0]
        else:
            mask_out = x[0] # long skip connection

        cond = self.cond_first(x[1])
        cond1 = self.CondNet1(cond)
        cond2 = self.CondNet2(cond)
        cond3 = self.CondNet3(cond)
        cond4 = self.CondNet4(cond)

        fea0 = self.act(self.conv_first(x[0]))

        fea0 = self.SFT_layer1((fea0, cond1))
        fea0 = self.act(self.HR_conv1(fea0))

        fea1 = self.act(self.down_conv1(fea0))
        fea1, _ = self.recon_trunk1((fea1, cond2))

        fea2 = self.act(self.down_conv2(fea1))
        fea2, _ = self.recon_trunk2((fea2, cond3))

        fea3 = self.act(self.down_conv3(fea2))
        out, _ = self.recon_trunk3((fea3, cond4))

        out = out + fea3

        out = self.act(self.up_conv1(out)) + fea2
        out, _ = self.recon_trunk4((out, cond3))

        out = self.act(self.up_conv2(out)) + fea1
        out, _ = self.recon_trunk5((out, cond2))

        out = self.act(self.up_conv3(out)) + fea0
        out = self.SFT_layer2((out, cond1))

        out = self.act(self.HR_conv2(out))

        out = self.conv_last(out)
        out = mask_out + out
        return out, x[0]


class Ensemble_AGCM_LE(nn.Module):
    def __init__(self, classifier='color_condition', cond_c=6, in_nc=3, out_nc=3, nf=32, act_type='relu', weighting_network=False):
        super(Ensemble_AGCM_LE, self).__init__()
        self.AGCM = ConditionNet(classifier=classifier, cond_c=cond_c)
        # fix AGCM
        # for p in self.parameters():
        #     p.requires_grad = False

        self.LE = HDRUNet3T1(in_nc=in_nc, out_nc=out_nc, nf=nf, act_type=act_type, weighting_network=weighting_network)

    def forward(self, x):
        condition_output, input = self.AGCM(x)
        LE_input = [condition_output, condition_output]
        # condition = image
        LE_output = self.LE(LE_input)
        return LE_output[0], condition_output
